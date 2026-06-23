// External knowledge tools for the ReAct fallback branch. Replaces
// backend/tools.py. Wikipedia's API is CORS-enabled (origin=*), so it works
// directly from the browser. arXiv's export API sends no CORS headers, so it is
// off by default (config.ENABLE_ARXIV) and best-effort when enabled.
(function () {
    const NH = (window.NH = window.NH || {});
    const { config, safeJson } = NH;

    function externalChunk(source, idx, title, text, url) {
        const label = { wikipedia: 'Wikipedia', arxiv: 'arXiv' }[source] || source;
        return {
            id: `ext_${source}_${idx}`,
            text: String(text).slice(0, config.EXTERNAL_TEXT_LIMIT),
            doc_id: `external:${source}`,
            filename: `${label}: ${title}`,
            page: 'web',
            chunk_idx: idx,
            source: 'external',
            url,
        };
    }

    // ---- Wikipedia (CORS-friendly) ----
    async function wikipediaSearch(query, limit = 3) {
        const searchUrl =
            'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json' +
            `&origin=*&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`;
        let hits;
        try {
            const data = await (await fetch(searchUrl)).json();
            hits = (data.query?.search || []).slice(0, limit);
        } catch (_) {
            return [];
        }
        const chunks = [];
        for (let i = 0; i < hits.length; i++) {
            const title = hits[i].title;
            if (!title) continue;
            try {
                const sUrl =
                    'https://en.wikipedia.org/api/rest_v1/page/summary/' +
                    encodeURIComponent(title.replace(/ /g, '_'));
                const s = await (await fetch(sUrl)).json();
                const extract = (s.extract || '').trim();
                if (!extract) continue;
                const pageUrl =
                    s.content_urls?.desktop?.page ||
                    `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
                chunks.push(externalChunk('wikipedia', i, title, extract, pageUrl));
            } catch (_) {
                continue;
            }
        }
        return chunks;
    }

    // ---- arXiv (best-effort; may fail on CORS) ----
    async function arxivSearch(query, limit = 3) {
        if (!config.ENABLE_ARXIV) return [];
        const url =
            'https://export.arxiv.org/api/query?' +
            `search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
        try {
            const xml = await (await fetch(url)).text();
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const entries = Array.from(doc.getElementsByTagName('entry')).slice(0, limit);
            const chunks = [];
            entries.forEach((entry, i) => {
                const title = (entry.getElementsByTagName('title')[0]?.textContent || '').trim();
                const summary = (entry.getElementsByTagName('summary')[0]?.textContent || '').trim();
                const link = (entry.getElementsByTagName('id')[0]?.textContent || '').trim();
                if (!title || !summary) return;
                chunks.push(externalChunk('arxiv', i, title, `${title}. ${summary}`, link));
            });
            return chunks;
        } catch (_) {
            return []; // CORS or network — degrade gracefully
        }
    }

    const TOOLS = { wikipedia: wikipediaSearch, arxiv: arxivSearch };

    // Ask Gemini which external tool fits the gap. (was select_tool)
    async function selectTool(question, failedClaims) {
        const fallback = { tool: 'wikipedia', query: question, reason: 'default external lookup' };
        const failedBlock =
            (failedClaims || [])
                .map((f) => `- ${f.claim || ''} (${f.reason || ''})`)
                .join('\n') || '(none)';
        const arxivLine = config.ENABLE_ARXIV
            ? "  - 'arxiv': cutting-edge research, technical/scientific papers, recent methods.\n"
            : '';
        const prompt =
            'You are a research agent deciding how to fill a knowledge gap.\n' +
            'The internal document library could not verify an answer. Pick ONE external tool:\n' +
            "  - 'wikipedia': general/background knowledge, definitions, well-established facts.\n" +
            arxivLine +
            "Return ONLY valid JSON with keys 'tool', 'query' (a short search string), " +
            "and 'reason' (one short clause).\n\n" +
            `Question: ${question}\n` +
            `Claims we failed to verify internally:\n${failedBlock}\n\n` +
            'JSON:';
        try {
            const parsed = safeJson(await NH.gemini.askGemini(prompt));
            if (!parsed) return fallback;
            let tool = parsed.tool;
            if (!TOOLS[tool] || (tool === 'arxiv' && !config.ENABLE_ARXIV)) tool = 'wikipedia';
            return {
                tool,
                query: (parsed.query || question).trim(),
                reason: String(parsed.reason || '').slice(0, 200),
            };
        } catch (_) {
            return fallback;
        }
    }

    async function runTool(tool, query, limit = 3) {
        const fn = TOOLS[tool] || wikipediaSearch;
        return fn(query, limit);
    }

    NH.tools = { wikipediaSearch, arxivSearch, selectTool, runTool };
})();
