// The agent orchestrator. Replaces backend/graph.py (LangGraph state machine)
// and the SSE streaming in endpoint.py. runAgent(question, onEvent) runs the same
// pipeline — planner -> router -> retrieve (fan-out) -> generator -> critic ->
// rewriter / external_tools — and calls onEvent with the EXACT event shapes the
// old stream_answer() yielded, so the existing UI rendering is unchanged.
(function () {
    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const NH = (root.NH = root.NH || {});
    const { config, stripFences, safeJson } = NH;
    const { MAX_RETRIES, MAX_SUBQ, MAX_CONTEXT_CHUNKS } = config;

    // ---- chunk prep (mirrors _dedupe_chunks / _prepare_chunks) ----
    function dedupeChunks(chunks) {
        const seen = new Set();
        const out = [];
        for (const c of chunks) {
            const key = c.id || `${c.doc_id}:${c.chunk_idx}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(c);
        }
        return out;
    }

    function prepareChunks(chunks) {
        const deduped = dedupeChunks(chunks);
        const external = deduped.filter((c) => c.source === 'external');
        const internal = deduped.filter((c) => c.source !== 'external');
        internal.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
        return external.concat(internal).slice(0, MAX_CONTEXT_CHUNKS);
    }

    // ---- nodes ----
    async function plannerNode(state) {
        const prompt =
            'You break a study question into the minimal set of standalone sub-questions ' +
            'needed to answer it from a document library.\n' +
            'If the question is already a single, focused ask, return it unchanged as the only element.\n' +
            `Return ONLY a JSON array of ${MAX_SUBQ} or fewer short sub-question strings. No prose, no code fences.\n\n` +
            `Question: ${state.question}\n\n` +
            'JSON array:';
        let subs = [];
        const picked = safeJson(await NH.gemini.askGemini(prompt));
        if (Array.isArray(picked)) {
            subs = picked.map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_SUBQ);
        }
        if (!subs.length) subs = [state.question];
        return subs;
    }

    async function routerNode(state, docs) {
        if (!docs.length) return { doc_ids: [], query: state.query || state.question };
        if (docs.length === 1) return { doc_ids: [docs[0].doc_id], query: state.query || state.question };

        const catalog = docs
            .map(
                (d) =>
                    `- doc_id=${d.doc_id} | filename=${d.filename} | ` +
                    `summary=${(d.summary || {}).one_sentence_explanation || ''}`
            )
            .join('\n');
        const subs = state.sub_questions || [];
        const subBlock =
            subs.length > 1
                ? '\nSub-questions to cover:\n' + subs.map((s) => `  - ${s}`).join('\n') + '\n'
                : '';
        const prompt =
            'You are a router that picks relevant documents for a question.\n' +
            'Return ONLY a JSON array of doc_id strings, no prose, no code fences.\n' +
            'If unsure, include more rather than fewer.\n\n' +
            `Available documents:\n${catalog}\n${subBlock}\n` +
            `Question: ${state.question}\n\n` +
            'JSON array of doc_ids:';
        const valid = new Set(docs.map((d) => d.doc_id));
        let picked = safeJson(await NH.gemini.askGemini(prompt));
        picked = Array.isArray(picked) ? picked.filter((d) => valid.has(d)) : [];
        if (!picked.length) picked = docs.map((d) => d.doc_id);
        return { doc_ids: picked, query: state.query || state.question };
    }

    // fan-out retrieval (mirrors fan_out_to_retrievers + retriever_node)
    async function retrievePhase(state, onEvent) {
        const onRetry = state.retry_count > 0 && state.query;
        const queries = onRetry
            ? [state.query]
            : state.sub_questions && state.sub_questions.length
            ? state.sub_questions
            : [state.query || state.question];
        const docIds = state.doc_ids && state.doc_ids.length ? state.doc_ids : [null];
        const k = queries.length * docIds.length > 4 ? 3 : 4;

        // Embed each unique query once, then fan out over routed docs reusing the
        // vectors — the cross product previously re-embedded the same query per doc.
        const uniqueQueries = [...new Set(queries)];
        const vecs = await NH.gemini.embed(uniqueQueries, 'RETRIEVAL_QUERY');
        const vecByQuery = new Map(uniqueQueries.map((q, i) => [q, vecs[i]]));

        const jobs = [];
        for (const q of queries) for (const d of docIds) jobs.push({ q, d });
        const results = await Promise.all(
            jobs.map(({ q, d }) => NH.store.retrieveByVector(vecByQuery.get(q), d ? [d] : null, k))
        );
        for (const chunks of results) {
            state.chunks.push(...chunks);
            onEvent({ node: 'retriever', chunks_added: chunks.length });
        }
    }

    async function generatorNode(state) {
        const chunks = prepareChunks(state.chunks);
        if (!chunks.length) {
            return {
                answer: "I couldn't find anything in your library that addresses this question.",
                consulted: [],
            };
        }
        const contextBlock = chunks
            .map((c, i) => `[${i + 1}] (${c.filename} p.${c.page})\n${c.text}`)
            .join('\n\n');
        const failed = state.failed_claims || [];
        let retryHint = '';
        if (failed.length) {
            retryHint =
                '\n\nNOTE: A previous attempt failed citation verification on these claims:\n' +
                failed.map((f) => `- "${f.claim}" — ${f.reason}`).join('\n') +
                '\nBe more careful this time — only assert what the chunks explicitly support.';
        }
        const prompt =
            'Answer the question using ONLY the provided chunks.\n' +
            'Every factual claim MUST end with a citation tag like [1], [2], or [1,3].\n' +
            'If chunks do not support an answer, say so plainly (no citation needed for that disclaimer).\n' +
            "Return ONLY valid JSON with one key 'answer'. No markdown, no code fences.\n\n" +
            `Chunks:\n${contextBlock}${retryHint}\n\n` +
            `Question: ${state.question}\n\n` +
            'JSON:';
        let answer;
        try {
            const raw = stripFences(await NH.gemini.askGemini(prompt));
            const parsed = safeJson(raw);
            answer = parsed && typeof parsed.answer === 'string' ? parsed.answer : raw;
        } catch (e) {
            answer = `Error generating answer: ${e.message}`;
        }
        const seen = new Set();
        const consulted = [];
        for (const c of chunks) {
            if (!seen.has(c.doc_id)) {
                seen.add(c.doc_id);
                consulted.push({ doc_id: c.doc_id, filename: c.filename });
            }
        }
        return { answer, consulted };
    }

    // ---- critic helpers (mirror _extract_claims / _verify_claim) ----
    const CITATION_RE = /\[([\d,\s]+)\]/g;
    const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z0-9])/;

    function extractClaims(answer) {
        const claims = [];
        for (const sentence of answer.trim().split(SENTENCE_SPLIT_RE)) {
            const nums = [];
            let m;
            CITATION_RE.lastIndex = 0;
            while ((m = CITATION_RE.exec(sentence)) !== null) {
                for (const tok of m[1].split(',')) {
                    const t = tok.trim();
                    if (/^\d+$/.test(t)) nums.push(parseInt(t, 10));
                }
            }
            if (nums.length) {
                // Strip the citation tags, then tidy the gap they leave behind so
                // the claim text (shown in the citation-evidence panel) doesn't carry
                // a floating " ." or double spaces.
                const claim = sentence
                    .replace(CITATION_RE, '')
                    .replace(/\s+([.,!?;:])/g, '$1')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                claims.push({ claim, chunk_nums: nums });
            }
        }
        return claims;
    }

    async function verifyClaim(claim, chunkText) {
        const prompt =
            'You verify factual support. Decide whether the CLAIM is explicitly supported by the CHUNK.\n' +
            "Return ONLY valid JSON with keys 'supported' (true/false) and 'reason' (short).\n" +
            'Be strict: paraphrase is OK, but the chunk must contain the substance of the claim. ' +
            'If the chunk is unrelated or missing key facts, set supported=false.\n\n' +
            `CLAIM: ${claim}\n\n` +
            `CHUNK: ${chunkText}\n\n` +
            'JSON:';
        try {
            const parsed = safeJson(await NH.gemini.askGemini(prompt));
            if (!parsed) throw new Error('unparseable verifier output');
            return { supported: !!parsed.supported, reason: String(parsed.reason || '').slice(0, 240) };
        } catch (e) {
            // lenient: a transient verifier failure shouldn't fail the answer
            // (graph.py:304), but flag it `unverified` so the UI can be honest
            // about it rather than showing a false "supported".
            return {
                supported: true,
                unverified: true,
                reason: `(verifier error, defaulting to pass: ${e.message})`,
            };
        }
    }

    async function criticNode(state) {
        const chunks = prepareChunks(state.chunks);
        const answer = state.answer || '';
        const extracted = extractClaims(answer);

        if (!extracted.length) {
            const lower = answer.toLowerCase();
            const isDisclaimer =
                lower.includes('could not') || lower.includes("don't") ||
                lower.includes('do not') || lower.includes("couldn't");
            return {
                verified: isDisclaimer || !chunks.length,
                citations: [],
                failed_claims: isDisclaimer
                    ? []
                    : [{ claim: answer.slice(0, 120), reason: 'answer has no [N] citations' }],
                retry_count: state.retry_count + (isDisclaimer ? 0 : 1),
            };
        }

        // Flatten to (claim, cited chunk) pairs and verify them in parallel —
        // the LLM round-trips are independent, so there's no need to serialize them.
        const pairs = [];
        for (const entry of extracted) {
            for (const n of entry.chunk_nums) pairs.push({ entry, n });
        }
        const verdicts = await Promise.all(
            pairs.map(({ entry, n }) =>
                n < 1 || n > chunks.length
                    ? Promise.resolve(null) // out of range — no LLM call needed
                    : verifyClaim(entry.claim, chunks[n - 1].text)
            )
        );

        const citations = [];
        const failed = [];
        pairs.forEach(({ entry, n }, i) => {
            if (n < 1 || n > chunks.length) {
                failed.push({ claim: entry.claim, reason: `cited chunk [${n}] does not exist` });
                citations.push({ n, claim: entry.claim, supported: false, reason: 'out of range' });
                return;
            }
            const chunk = chunks[n - 1];
            const verdict = verdicts[i];
            citations.push({
                n,
                claim: entry.claim,
                chunk_id: chunk.id,
                filename: chunk.filename,
                page: chunk.page,
                supported: verdict.supported,
                unverified: !!verdict.unverified,
                reason: verdict.reason,
            });
            if (!verdict.supported) failed.push({ claim: entry.claim, reason: verdict.reason });
        });
        return {
            verified: failed.length === 0,
            citations,
            failed_claims: failed,
            retry_count: state.retry_count + (failed.length ? 1 : 0),
        };
    }

    async function rewriterNode(state) {
        const failed = state.failed_claims || [];
        if (!failed.length) return state.query || state.question;
        const failedBlock = failed.map((f) => `- ${f.claim} (${f.reason})`).join('\n');
        const prompt =
            'You rewrite a retrieval query to better surface evidence for unverified claims.\n' +
            "Return ONLY a JSON object with one key 'query' (a single short search query string).\n\n" +
            `Original question: ${state.question}\n` +
            `Previous query: ${state.query || ''}\n` +
            `Unverified claims (need better evidence):\n${failedBlock}\n\n` +
            'JSON:';
        const parsed = safeJson(await NH.gemini.askGemini(prompt));
        return (parsed && parsed.query) || state.question;
    }

    async function externalToolsNode(state) {
        const failed = state.failed_claims || [];
        const choice = await NH.tools.selectTool(state.question, failed);
        const results = await NH.tools.runTool(choice.tool, choice.query);
        return { chunks: results, tool_used: { ...choice, results: results.length } };
    }

    // ---- driver (mirrors stream_answer + critic_decides) ----
    async function runAgent(question, onEvent) {
        try {
            await runPipeline(question, onEvent);
        } catch (err) {
            // Surface any node failure through the same event channel the UI
            // already renders, instead of rejecting with an uncaught error.
            onEvent({ node: 'error', message: (err && err.message) || String(err) });
        }
    }

    async function runPipeline(question, onEvent) {
        const state = {
            question,
            query: question,
            retry_count: 0,
            chunks: [],
            external_used: false,
            failed_claims: [],
        };

        state.sub_questions = await plannerNode(state);
        onEvent({ node: 'planner', sub_questions: state.sub_questions, multi: state.sub_questions.length > 1 });

        const docs = await NH.store.listDocuments();
        const routed = await routerNode(state, docs);
        state.doc_ids = routed.doc_ids;
        state.query = routed.query;
        onEvent({ node: 'router', doc_ids: state.doc_ids, query: state.query });

        let skipRetrieve = false;
        while (true) {
            if (!skipRetrieve) await retrievePhase(state, onEvent);
            skipRetrieve = false;

            const g = await generatorNode(state);
            state.answer = g.answer;
            state.consulted = g.consulted;
            onEvent({ node: 'generator', answer: state.answer, consulted: state.consulted });

            const c = await criticNode(state);
            state.verified = c.verified;
            state.citations = c.citations;
            state.failed_claims = c.failed_claims;
            state.retry_count = c.retry_count;
            onEvent({
                node: 'critic',
                verified: state.verified,
                citations: state.citations,
                failed_claims: state.failed_claims,
                retry_count: state.retry_count,
            });

            if (state.verified) break;
            if (state.retry_count < MAX_RETRIES) {
                state.query = await rewriterNode(state);
                onEvent({ node: 'rewriter', query: state.query });
                continue; // re-retrieve with the narrowed query
            }
            if (!state.external_used) {
                const ext = await externalToolsNode(state);
                state.chunks.push(...ext.chunks);
                state.external_used = true;
                state.tool_used = ext.tool_used;
                state.failed_claims = []; // fresh start on the merged pool
                onEvent({
                    node: 'external_tools',
                    tool: ext.tool_used.tool,
                    query: ext.tool_used.query,
                    reason: ext.tool_used.reason,
                    results: ext.tool_used.results,
                });
                skipRetrieve = true; // external branch loops back to the generator
                continue;
            }
            break;
        }
        onEvent({ node: 'done' });
    }

    NH.agent = { runAgent };

    // Node/test export (no-op in the browser). Exposes the pure helpers used by
    // the critic and chunk-prep stages so they can be unit-tested in isolation.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { extractClaims, dedupeChunks, prepareChunks, CITATION_RE, SENTENCE_SPLIT_RE };
    }
})();
