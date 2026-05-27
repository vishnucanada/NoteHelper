const API_BASE = 'http://127.0.0.1:5000';

document.addEventListener('DOMContentLoaded', () => {
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const uploadQueue = document.getElementById('uploadQueue');
    const libraryList = document.getElementById('libraryList');
    const libraryCount = document.getElementById('libraryCount');
    const questionInput = document.getElementById('questionInput');
    const askBtn = document.getElementById('askBtn');
    const qaResponse = document.getElementById('qaResponse');

    uploadArea.addEventListener('click', () => fileInput.click());

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('active');
    });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('active'));
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('active');
        if (e.dataTransfer.files.length) {
            handleFiles(Array.from(e.dataTransfer.files));
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            handleFiles(Array.from(fileInput.files));
            fileInput.value = '';
        }
    });

    askBtn.addEventListener('click', askQuestion);
    questionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') askQuestion();
    });

    refreshLibrary();

    async function handleFiles(files) {
        const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (pdfs.length === 0) {
            alert('Please select PDF files.');
            return;
        }
        for (const file of pdfs) {
            await uploadOne(file);
        }
        await refreshLibrary();
    }

    async function uploadOne(file) {
        const row = document.createElement('div');
        row.className = 'queue-row pending';
        row.innerHTML = `
            <span class="queue-name">${escapeHtml(file.name)}</span>
            <span class="queue-status">Uploading…</span>
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
        } catch (err) {
            row.className = 'queue-row error';
            row.querySelector('.queue-status').textContent = `✗ ${err.message}`;
        }
    }

    async function refreshLibrary() {
        try {
            const res = await fetch(`${API_BASE}/documents`);
            const result = await res.json();
            const docs = result.documents || [];
            libraryCount.textContent = `${docs.length} doc${docs.length === 1 ? '' : 's'}`;

            if (docs.length === 0) {
                libraryList.innerHTML = '<p class="empty-state">No documents yet. Upload a PDF above to get started.</p>';
                return;
            }

            libraryList.innerHTML = '';
            for (const doc of docs) {
                const card = document.createElement('div');
                card.className = 'doc-card';
                const summary = doc.summary || {};
                card.innerHTML = `
                    <div class="doc-header">
                        <div>
                            <h4 class="doc-title">${escapeHtml(doc.filename)}</h4>
                            <p class="doc-one-liner">${escapeHtml(summary.one_sentence_explanation || '(no summary)')}</p>
                        </div>
                        <button class="button-ghost" data-doc-id="${doc.doc_id}" data-action="delete">Delete</button>
                    </div>
                    <details class="doc-details">
                        <summary>Show summary &amp; takeaways</summary>
                        <p><strong>Brief Summary:</strong> ${escapeHtml(summary.brief_summary || '')}</p>
                        <p><strong>Key Takeaways:</strong> ${escapeHtml(summary.key_take_aways || '')}</p>
                        <p class="doc-meta">${doc.num_chunks} chunks · doc_id <code>${doc.doc_id}</code></p>
                    </details>
                `;
                libraryList.appendChild(card);
            }
            libraryList.querySelectorAll('[data-action="delete"]').forEach(btn => {
                btn.addEventListener('click', () => deleteDoc(btn.dataset.docId));
            });
        } catch (err) {
            console.error('Failed to load library:', err);
            libraryList.innerHTML = `<p class="error-state">Failed to load library: ${escapeHtml(err.message)}</p>`;
        }
    }

    async function deleteDoc(docId) {
        if (!confirm('Delete this document from your library?')) return;
        try {
            const res = await fetch(`${API_BASE}/documents/${docId}`, { method: 'DELETE' });
            if (!res.ok) {
                const r = await res.json();
                throw new Error(r.error || `Server error: ${res.status}`);
            }
            await refreshLibrary();
        } catch (err) {
            alert(`Delete failed: ${err.message}`);
        }
    }

    async function askQuestion() {
        const question = questionInput.value.trim();
        if (!question) return;

        askBtn.disabled = true;
        askBtn.textContent = 'Thinking…';
        qaResponse.classList.add('loading');
        qaResponse.textContent = 'Routing → retrieving → synthesizing…';

        try {
            const res = await fetch(`${API_BASE}/followup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question }),
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || `Server error: ${res.status}`);

            qaResponse.classList.remove('loading');
            const data = result.data;
            const consultedBadges = (data.consulted || []).map(
                c => `<span class="badge">${escapeHtml(c.filename)}</span>`
            ).join('');

            const item = document.createElement('div');
            item.className = 'qa-item';
            item.innerHTML = `
                <p class="qa-q"><strong>Q:</strong> ${escapeHtml(question)}</p>
                <p class="qa-a"><strong>A:</strong> ${escapeHtml(data.answer)}</p>
                <div class="qa-meta">
                    <span class="meta-label">Consulted:</span> ${consultedBadges || '<em>none</em>'}
                </div>
            `;
            qaResponse.textContent = '';
            qaResponse.appendChild(item);
            questionInput.value = '';
        } catch (err) {
            qaResponse.classList.remove('loading');
            qaResponse.classList.add('error');
            qaResponse.textContent = `Error: ${err.message}`;
        } finally {
            askBtn.disabled = false;
            askBtn.textContent = 'Ask';
        }
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
