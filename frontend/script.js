// Backendless: all work happens in the browser via the NH.* modules
// (lib/agent.js, lib/store.js, lib/gemini.js, lib/chunker.js, lib/apikey.js).
const NH = window.NH;

document.addEventListener('DOMContentLoaded', () => {
    const uploadArea    = document.getElementById('uploadArea');
    const fileInput     = document.getElementById('fileInput');
    const uploadQueue   = document.getElementById('uploadQueue');
    const libraryList   = document.getElementById('libraryList');
    const libraryCount  = document.getElementById('libraryCount');
    const questionInput = document.getElementById('questionInput');
    const askBtn        = document.getElementById('askBtn');
    const thread        = document.getElementById('thread');
    const welcome       = document.getElementById('welcome');
    const settingsBtn   = document.getElementById('settingsBtn');

    /* ---------- API key ---------- */
    settingsBtn?.addEventListener('click', () => NH.apikey.openModal());
    // Prompt for the key on first run so the app is usable immediately.
    NH.apikey.promptIfMissing();

    /* ---------- upload ---------- */
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('active');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('active'));
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('active');
        if (e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            handleFiles(Array.from(fileInput.files));
            fileInput.value = '';
        }
    });

    /* ---------- composer ---------- */
    questionInput.addEventListener('input', autoresize);
    questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            askQuestion();
        }
    });
    askBtn.addEventListener('click', askQuestion);

    refreshLibrary();
    restoreHistory();

    /* ---------- chat history (persisted in IndexedDB) ---------- */
    async function restoreHistory() {
        let turns = [];
        try { turns = await NH.store.listChatTurns(); } catch (_) { return; }
        if (!turns.length) return;
        welcome?.remove();
        for (const saved of turns) {
            const turn = document.createElement('div');
            turn.className = 'qa-turn';
            turn.innerHTML = `
                <div class="qa-question">${escapeHtml(saved.question || '')}</div>
                <div class="qa-answer" data-turn>
                    <div class="answer-body" data-answer></div>
                    <div data-retry hidden></div>
                    <div data-tail></div>
                </div>`;
            thread.appendChild(turn);
            renderFinal(turn, {
                finalAnswer: saved.answer || '',
                finalCitations: saved.citations || [],
                finalConsulted: saved.consulted || [],
                lastCritic: { verified: saved.verified, citations: saved.citations || [], retry_count: saved.retry_count || 0 },
            }, { persist: false });
        }
        scrollToBottom();
    }

    function turnToMarkdown(question, answer, citations, consulted) {
        let md = `## ${question}\n\n${answer}\n`;
        if (consulted && consulted.length) {
            md += `\n**Consulted:** ${consulted.map(c => c.filename).join(', ')}\n`;
        }
        if (citations && citations.length) {
            md += `\n### Citations\n`;
            for (const c of citations) {
                md += `- [${c.n}] ${c.filename || '?'}${c.page ? ' p.' + c.page : ''} — ${c.supported ? 'supported' : 'unsupported'}: ${c.claim}\n`;
            }
        }
        return md;
    }

    /* ---------- upload handlers ---------- */
    async function handleFiles(files) {
        const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (pdfs.length === 0) {
            flash('Only PDF files are supported.', 'error');
            return;
        }
        for (const file of pdfs) await uploadOne(file);
        await refreshLibrary();
    }

    async function uploadOne(file) {
        const row = document.createElement('div');
        row.className = 'queue-row pending';
        row.innerHTML = `
            <span class="queue-name">${escapeHtml(file.name)}</span>
            <span class="queue-status shimmer-text">indexing…</span>
        `;
        uploadQueue.appendChild(row);
        try {
            if (!NH.apikey.has()) { NH.apikey.openModal(); throw new Error('add your API key first'); }
            const docId = NH.chunker.newDocId();
            const { chunks, fullText } = await NH.chunker.chunkPdf(file, docId, file.name);
            if (!chunks.length) throw new Error('Could not extract text from PDF');
            const summary = await NH.gemini.summarizeThis(fullText);
            await NH.store.addDocument(docId, file.name, summary, chunks);
            row.className = 'queue-row done';
            row.querySelector('.queue-status').textContent = `✓ ${chunks.length} chunks`;
            row.querySelector('.queue-status').classList.remove('shimmer-text');
            setTimeout(() => row.remove(), 3500);
        } catch (err) {
            row.className = 'queue-row error';
            row.querySelector('.queue-status').textContent = `✗ ${err.message}`;
            row.querySelector('.queue-status').classList.remove('shimmer-text');
        }
    }

    async function refreshLibrary() {
        try {
            const docs = await NH.store.listDocuments();
            libraryCount.textContent = docs.length;
            if (docs.length === 0) {
                libraryList.innerHTML = '<p class="empty-state">No documents yet.</p>';
                return;
            }
            libraryList.innerHTML = '';
            for (const doc of docs) libraryList.appendChild(renderDocCard(doc));
        } catch (err) {
            libraryList.innerHTML = `<p class="empty-state error-state">${escapeHtml(err.message)}</p>`;
        }
    }

    function renderDocCard(doc) {
        const summary = doc.summary || {};
        const card = document.createElement('div');
        card.className = 'doc-card';
        card.dataset.docId = doc.doc_id;
        const takeaways = Array.isArray(summary.key_take_aways)
            ? summary.key_take_aways.map(t => `• ${escapeHtml(t)}`).join('<br>')
            : escapeHtml(summary.key_take_aways || '');
        card.innerHTML = `
            <div class="doc-header">
                <span class="doc-icon">📄</span>
                <div class="doc-main">
                    <p class="doc-title" title="${escapeHtml(doc.filename)}">${escapeHtml(doc.filename)}</p>
                    <p class="doc-one-liner">${escapeHtml(summary.one_sentence_explanation || '(no summary)')}</p>
                </div>
                <button class="doc-delete" title="Delete" data-doc-id="${doc.doc_id}">✕</button>
            </div>
            <details class="doc-details">
                <summary>Summary</summary>
                <p><strong>Brief:</strong> ${escapeHtml(summary.brief_summary || '—')}</p>
                <p><strong>Takeaways:</strong><br>${takeaways || '—'}</p>
                <p class="doc-meta">${doc.num_chunks} chunks · <code>${doc.doc_id}</code></p>
                <button class="doc-quiz" type="button" data-doc-id="${doc.doc_id}">🧠 Generate quiz</button>
                <div class="doc-quiz-out" data-quiz-out hidden></div>
            </details>
        `;
        card.querySelector('.doc-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteDoc(doc.doc_id);
        });
        card.querySelector('.doc-quiz').addEventListener('click', (e) => {
            e.stopPropagation();
            generateQuiz(doc, card.querySelector('[data-quiz-out]'));
        });
        return card;
    }

    async function deleteDoc(docId) {
        if (!confirm('Remove this document from your library?')) return;
        try {
            await NH.store.deleteDocument(docId);
            await refreshLibrary();
        } catch (err) {
            flash(`Delete failed: ${err.message}`, 'error');
        }
    }

    /* ---------- per-document quiz generation ---------- */
    async function generateQuiz(doc, outEl) {
        if (!NH.apikey.has()) { NH.apikey.openModal(); return; }
        outEl.hidden = false;
        outEl.innerHTML = '<span class="shimmer-text">Generating quiz…</span>';
        const s = doc.summary || {};
        const takeaways = Array.isArray(s.key_take_aways) ? s.key_take_aways.join('; ') : (s.key_take_aways || '');
        const prompt =
            'Create 5 short study quiz questions with answers based on this document. ' +
            "Return ONLY valid JSON: an array of objects with keys 'q' and 'a'. No prose, no code fences.\n\n" +
            `Title: ${doc.filename}\n` +
            `Summary: ${s.brief_summary || s.one_sentence_explanation || ''}\n` +
            `Key points: ${takeaways}`;
        try {
            const items = NH.safeJson(await NH.gemini.askGemini(prompt));
            if (!Array.isArray(items) || !items.length) throw new Error('no questions returned');
            outEl.innerHTML = items.map((it, i) => `
                <details class="quiz-item">
                    <summary>${i + 1}. ${escapeHtml(it.q || '')}</summary>
                    <p>${escapeHtml(it.a || '')}</p>
                </details>`).join('');
        } catch (err) {
            outEl.innerHTML = `<span class="error-state">Quiz failed: ${escapeHtml(err.message)}</span>`;
        }
    }

    /* ---------- Q&A: agentic graph (in-browser) ---------- */
    async function askQuestion() {
        const question = questionInput.value.trim();
        if (!question || askBtn.disabled) return;

        welcome?.remove();

        const turn = document.createElement('div');
        turn.className = 'qa-turn';
        turn.innerHTML = `
            <div class="qa-question">${escapeHtml(question)}</div>
            <div class="qa-answer loading" data-turn>
                <div class="routing-trace" data-trace>
                    <span class="trace-pill active" data-step="router">🧭 routing</span>
                    <span class="trace-arrow">→</span>
                    <span class="trace-pill" data-step="retriever">📥 retrieving</span>
                    <span class="trace-arrow">→</span>
                    <span class="trace-pill" data-step="generator">✨ generating</span>
                    <span class="trace-arrow">→</span>
                    <span class="trace-pill" data-step="critic">✅ verifying</span>
                </div>
                <div class="retry-indicator" data-retry hidden></div>
                <div class="answer-body shimmer-text" data-answer>Routing your question to the relevant documents…</div>
                <div data-tail></div>
            </div>
        `;
        thread.appendChild(turn);
        scrollToBottom();

        questionInput.value = '';
        autoresize();
        askBtn.disabled = true;

        const answerEl = turn.querySelector('[data-turn]');
        const traceEl  = turn.querySelector('[data-trace]');
        const bodyEl   = turn.querySelector('[data-answer]');
        const retryEl  = turn.querySelector('[data-retry]');
        const tailEl   = turn.querySelector('[data-tail]');

        const ctx = {
            chunksAccumulated: 0,
            lastCritic: null,
            finalAnswer: '',
            finalChunks: [],
            finalConsulted: [],
            finalCitations: [],
            finalDocs: [],
        };

        function setActive(step, label) {
            traceEl.querySelectorAll('.trace-pill').forEach(p => p.classList.remove('active'));
            const pill = traceEl.querySelector(`[data-step="${step}"]`);
            if (pill) {
                pill.classList.add('active');
                if (label) pill.textContent = label;
            }
        }

        function markDone(step, label) {
            const pill = traceEl.querySelector(`[data-step="${step}"]`);
            if (pill) {
                pill.classList.remove('active');
                pill.classList.add('done');
                if (label) pill.textContent = label;
            }
        }

        try {
            if (!NH.apikey.has()) { NH.apikey.openModal(); throw new Error('add your API key to ask questions'); }
            await NH.agent.runAgent(question, (evt) => {
                switch (evt.node) {
                    case 'router':
                        markDone('router', `🧭 routed → ${evt.doc_ids.length} doc${evt.doc_ids.length === 1 ? '' : 's'}`);
                        setActive('retriever', `📥 retrieving (0)`);
                        ctx.finalDocs = evt.doc_ids;
                        bodyEl.textContent = 'Retrieving relevant chunks…';
                        break;
                    case 'retriever':
                        ctx.chunksAccumulated += evt.chunks_added || 0;
                        setActive('retriever', `📥 retrieving (${ctx.chunksAccumulated})`);
                        break;
                    case 'generator':
                        markDone('retriever', `📥 ${ctx.chunksAccumulated} chunks`);
                        setActive('generator', '✨ generating');
                        bodyEl.textContent = 'Synthesizing the answer…';
                        ctx.finalAnswer = evt.answer || '';
                        ctx.finalConsulted = evt.consulted || [];
                        break;
                    case 'critic': {
                        markDone('generator', '✨ generated');
                        const okPill = evt.verified ? '✅ verified' : '⚠ unverified';
                        setActive('critic', okPill);
                        ctx.lastCritic = evt;
                        ctx.finalCitations = evt.citations || [];
                        if (!evt.verified && evt.retry_count < 2) {
                            // about to retry — surface a retry indicator
                            const used = evt.retry_count;
                            retryEl.hidden = false;
                            retryEl.innerHTML = `<span class="retry-chip">↻ ${used === 1 ? 'first' : 'second'} retry: ${evt.failed_claims.length} claim(s) failed</span>`;
                            // reset trace for retry
                            setTimeout(() => {
                                traceEl.querySelectorAll('.trace-pill').forEach(p => {
                                    p.classList.remove('done');
                                });
                                ['generator', 'critic'].forEach(s => {
                                    const pill = traceEl.querySelector(`[data-step="${s}"]`);
                                    if (pill) pill.textContent = ({generator: '✨ generating', critic: '✅ verifying'})[s];
                                });
                                setActive('retriever', `📥 retrieving (retry)`);
                                bodyEl.textContent = 'Rewriting query and re-retrieving…';
                            }, 250);
                        }
                        break;
                    }
                    case 'rewriter':
                        // soft indicator; the next retriever events will follow
                        break;
                    case 'done':
                        renderFinal(turn, ctx);
                        break;
                    case 'error':
                        throw new Error(evt.message || 'graph error');
                }
            });
            // safety: if no 'done' arrived for some reason
            if (!turn.classList.contains('rendered')) renderFinal(turn, ctx);
        } catch (err) {
            answerEl.classList.remove('loading');
            answerEl.classList.add('error');
            bodyEl.classList.remove('shimmer-text');
            bodyEl.textContent = `Error: ${err.message}`;
        } finally {
            askBtn.disabled = false;
            questionInput.focus();
            scrollToBottom();
        }
    }

    function renderFinal(turn, ctx, opts = {}) {
        if (turn.classList.contains('rendered')) return;
        turn.classList.add('rendered');
        const answerEl = turn.querySelector('[data-turn]');
        const bodyEl   = turn.querySelector('[data-answer]');
        const tailEl   = turn.querySelector('[data-tail]');
        const retryEl  = turn.querySelector('[data-retry]');

        answerEl.classList.remove('loading');
        bodyEl.classList.remove('shimmer-text');

        // Render answer with citation superscripts
        bodyEl.innerHTML = renderAnswerHtml(ctx.finalAnswer, ctx.finalCitations);

        // Verification badge
        const critic = ctx.lastCritic;
        const badgeHtml = critic
            ? (critic.verified
                ? `<span class="verify-badge ok">✓ verified · ${critic.citations.length} citation${critic.citations.length === 1 ? '' : 's'}</span>`
                : `<span class="verify-badge warn">⚠ best-effort · ${critic.retry_count} retr${critic.retry_count === 1 ? 'y' : 'ies'} used</span>`)
            : '';

        // Consulted docs
        const consultedHtml = ctx.finalConsulted.length ? `
            <div class="consulted-row">
                <span class="consulted-label">Consulted</span>
                ${ctx.finalConsulted.map(c => `<span class="badge">${escapeHtml(c.filename)}</span>`).join('')}
                ${badgeHtml}
            </div>` : (badgeHtml ? `<div class="consulted-row">${badgeHtml}</div>` : '');

        // Citations detail (foldable)
        const cits = ctx.finalCitations;
        const citationsHtml = cits.length ? `
            <button class="chunks-toggle" data-action="toggle-cits">Show citation evidence (${cits.length})</button>
            <div class="chunks-list" data-cits hidden>
                ${cits.map(c => `
                    <div class="chunk-item ${c.supported ? '' : 'unsupported'}">
                        <div class="chunk-meta">
                            [${c.n}] ${escapeHtml(c.filename || '?')} ${c.page ? '· page ' + c.page : ''}
                            <span class="${c.supported ? 'cite-ok' : 'cite-bad'}">${c.supported ? '✓ supported' : '✗ unsupported'}</span>
                        </div>
                        <div class="cit-claim"><em>Claim:</em> ${escapeHtml(c.claim)}</div>
                        ${c.reason ? `<div class="cit-reason"><em>Note:</em> ${escapeHtml(c.reason)}</div>` : ''}
                    </div>
                `).join('')}
            </div>` : '';

        const actionsHtml = `<div class="turn-actions"><button class="copy-md" type="button" data-action="copy-md">⧉ Copy as Markdown</button></div>`;
        tailEl.innerHTML = consultedHtml + citationsHtml + actionsHtml;

        // Copy-as-Markdown
        const question = turn.querySelector('.qa-question')?.textContent || '';
        const copyBtn = tailEl.querySelector('[data-action="copy-md"]');
        copyBtn?.addEventListener('click', async () => {
            await navigator.clipboard.writeText(turnToMarkdown(question, ctx.finalAnswer, cits, ctx.finalConsulted));
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => { copyBtn.textContent = '⧉ Copy as Markdown'; }, 1800);
        });

        // Persist this turn so the thread restores on reload (skip when replaying history)
        if (opts.persist !== false) {
            NH.store.saveChatTurn({
                question,
                answer: ctx.finalAnswer,
                citations: ctx.finalCitations,
                consulted: ctx.finalConsulted,
                verified: critic ? critic.verified : false,
                retry_count: critic ? critic.retry_count : 0,
            }).catch(() => {});
        }

        const citsToggle = tailEl.querySelector('[data-action="toggle-cits"]');
        if (citsToggle) {
            const list = tailEl.querySelector('[data-cits]');
            citsToggle.addEventListener('click', () => {
                const open = !list.hasAttribute('hidden');
                if (open) {
                    list.setAttribute('hidden', '');
                    citsToggle.textContent = `Show citation evidence (${cits.length})`;
                } else {
                    list.removeAttribute('hidden');
                    citsToggle.textContent = `Hide citation evidence`;
                }
            });
        }

        // Highlight consulted docs in sidebar (transient)
        const ids = new Set(ctx.finalConsulted.map(c => c.doc_id));
        libraryList.querySelectorAll('.doc-card').forEach(card => {
            card.classList.toggle('consulted', ids.has(card.dataset.docId));
        });
        setTimeout(() => {
            libraryList.querySelectorAll('.doc-card.consulted').forEach(c => c.classList.remove('consulted'));
        }, 4500);

        // Clear retry indicator after a beat
        if (retryEl && !retryEl.hidden) {
            setTimeout(() => { retryEl.hidden = true; }, 6000);
        }
    }

    function renderAnswerHtml(answer, citations) {
        const citByN = new Map();
        for (const c of citations) {
            if (!citByN.has(c.n)) citByN.set(c.n, c);
        }
        // Escape, then replace [N] tokens with superscript chips (after escape so brackets are literal)
        let html = escapeHtml(answer);
        html = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, nums) => {
            const parts = nums.split(',').map(s => s.trim());
            return parts.map(n => {
                const cit = citByN.get(parseInt(n, 10));
                const ok = cit?.supported !== false;
                const title = cit
                    ? `${cit.filename || ''} p.${cit.page || '?'} — ${cit.supported ? 'supported' : 'unsupported'}`
                    : `chunk ${n}`;
                return `<sup class="cite ${ok ? '' : 'cite-bad'}" title="${escapeHtml(title)}">[${n}]</sup>`;
            }).join('');
        });
        // preserve newlines as <br>
        html = html.replace(/\n/g, '<br>');
        return html;
    }

    /* ---------- utility ---------- */
    function scrollToBottom() { thread.scrollTop = thread.scrollHeight; }

    function autoresize() {
        questionInput.style.height = 'auto';
        questionInput.style.height = Math.min(questionInput.scrollHeight, 180) + 'px';
    }

    function flash(msg, kind) {
        const row = document.createElement('div');
        row.className = `queue-row ${kind === 'error' ? 'error' : 'done'}`;
        row.innerHTML = `<span class="queue-name">${escapeHtml(msg)}</span><span class="queue-status"></span>`;
        uploadQueue.appendChild(row);
        setTimeout(() => row.remove(), 3000);
    }

    function escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
});
