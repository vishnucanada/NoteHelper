const API_BASE = 'http://127.0.0.1:5000';

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
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            askQuestion();
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            askQuestion();
        }
    });
    askBtn.addEventListener('click', askQuestion);

    refreshLibrary();

    /* ---------- handlers ---------- */
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
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(`${API_BASE}/message`, { method: 'POST', body: formData });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || `Server error: ${res.status}`);

            row.className = 'queue-row done';
            row.querySelector('.queue-status').textContent = `✓ ${result.data.num_chunks} chunks`;
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
            const res = await fetch(`${API_BASE}/documents`);
            const result = await res.json();
            const docs = result.documents || [];
            libraryCount.textContent = docs.length;

            if (docs.length === 0) {
                libraryList.innerHTML = '<p class="empty-state">No documents yet.</p>';
                return;
            }

            libraryList.innerHTML = '';
            for (const doc of docs) {
                libraryList.appendChild(renderDocCard(doc));
            }
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
            </details>
        `;
        card.querySelector('.doc-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteDoc(doc.doc_id);
        });
        return card;
    }

    async function deleteDoc(docId) {
        if (!confirm('Remove this document from your library?')) return;
        try {
            const res = await fetch(`${API_BASE}/documents/${docId}`, { method: 'DELETE' });
            if (!res.ok) {
                const r = await res.json();
                throw new Error(r.error || `Server error: ${res.status}`);
            }
            await refreshLibrary();
        } catch (err) {
            flash(`Delete failed: ${err.message}`, 'error');
        }
    }

    /* ---------- Q&A thread ---------- */
    async function askQuestion() {
        const question = questionInput.value.trim();
        if (!question || askBtn.disabled) return;

        welcome?.remove();

        const turn = document.createElement('div');
        turn.className = 'qa-turn';
        turn.innerHTML = `
            <div class="qa-question">${escapeHtml(question)}</div>
            <div class="qa-answer loading">
                <div class="routing-trace">
                    <span class="trace-pill active" data-step="route">🧭 routing</span>
                    <span class="trace-arrow">→</span>
                    <span class="trace-pill" data-step="retrieve">📥 retrieving</span>
                    <span class="trace-arrow">→</span>
                    <span class="trace-pill" data-step="synth">✨ synthesizing</span>
                </div>
                <div class="answer-body shimmer-text">Routing your question to the relevant documents…</div>
            </div>
        `;
        thread.appendChild(turn);
        scrollToBottom();

        questionInput.value = '';
        autoresize();
        askBtn.disabled = true;

        // staged loading animation (purely cosmetic until backend returns)
        const stagedTimers = animateTrace(turn);

        try {
            const res = await fetch(`${API_BASE}/followup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question }),
            });
            const result = await res.json();
            stagedTimers.forEach(clearTimeout);

            if (!res.ok) throw new Error(result.error || `Server error: ${res.status}`);
            renderAnswer(turn, result.data);
            highlightConsulted(result.data.consulted || []);
        } catch (err) {
            stagedTimers.forEach(clearTimeout);
            const answer = turn.querySelector('.qa-answer');
            answer.classList.remove('loading');
            answer.classList.add('error');
            answer.querySelector('.answer-body').classList.remove('shimmer-text');
            answer.querySelector('.answer-body').textContent = `Error: ${err.message}`;
        } finally {
            askBtn.disabled = false;
            questionInput.focus();
            scrollToBottom();
        }
    }

    function animateTrace(turn) {
        const body = turn.querySelector('.answer-body');
        const pills = turn.querySelectorAll('.trace-pill');
        const timers = [];
        timers.push(setTimeout(() => {
            pills[0].classList.remove('active');
            pills[1].classList.add('active');
            body.textContent = 'Retrieving relevant chunks…';
        }, 900));
        timers.push(setTimeout(() => {
            pills[1].classList.remove('active');
            pills[2].classList.add('active');
            body.textContent = 'Synthesizing the answer…';
        }, 2100));
        return timers;
    }

    function renderAnswer(turn, data) {
        const answer = turn.querySelector('.qa-answer');
        answer.classList.remove('loading');

        const routed = data.routed_doc_ids?.length || 0;
        const consulted = data.consulted || [];
        const chunks = data.chunks || [];

        const consultedBadges = consulted.map(c =>
            `<span class="badge">${escapeHtml(c.filename)}</span>`
        ).join('');

        const chunksHtml = chunks.length ? `
            <button class="chunks-toggle" data-action="toggle-chunks">Show retrieved chunks (${chunks.length})</button>
            <div class="chunks-list" hidden>
                ${chunks.map(c => `
                    <div class="chunk-item">
                        <div class="chunk-meta">${escapeHtml(c.filename)} · page ${c.page}</div>
                        ${escapeHtml(c.text)}
                    </div>
                `).join('')}
            </div>
        ` : '';

        answer.innerHTML = `
            <div class="routing-trace">
                <span class="trace-pill active">🧭 routed → ${routed} doc${routed === 1 ? '' : 's'}</span>
                <span class="trace-arrow">→</span>
                <span class="trace-pill active">📥 ${chunks.length} chunks</span>
                <span class="trace-arrow">→</span>
                <span class="trace-pill active">✨ synthesized</span>
            </div>
            <div class="answer-body">${escapeHtml(data.answer)}</div>
            ${consulted.length ? `
                <div class="consulted-row">
                    <span class="consulted-label">Consulted</span>
                    ${consultedBadges}
                </div>` : ''}
            ${chunksHtml}
        `;

        const toggle = answer.querySelector('[data-action="toggle-chunks"]');
        if (toggle) {
            const list = answer.querySelector('.chunks-list');
            toggle.addEventListener('click', () => {
                const open = !list.hasAttribute('hidden');
                if (open) {
                    list.setAttribute('hidden', '');
                    toggle.textContent = `Show retrieved chunks (${chunks.length})`;
                } else {
                    list.removeAttribute('hidden');
                    toggle.textContent = `Hide retrieved chunks`;
                }
            });
        }
    }

    function highlightConsulted(consulted) {
        const ids = new Set(consulted.map(c => c.doc_id));
        libraryList.querySelectorAll('.doc-card').forEach(card => {
            card.classList.toggle('consulted', ids.has(card.dataset.docId));
        });
        setTimeout(() => {
            libraryList.querySelectorAll('.doc-card.consulted').forEach(c => c.classList.remove('consulted'));
        }, 4000);
    }

    function scrollToBottom() {
        thread.scrollTop = thread.scrollHeight;
    }

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
