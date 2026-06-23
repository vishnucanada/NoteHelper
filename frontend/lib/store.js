// IndexedDB-backed vector store. Replaces backend/vectorstore.py + ChromaDB and
// the documents.json sidecar. Embeddings come from gemini.js; similarity ranking
// is plain cosine in JS. Function names + returned shapes mirror the old module
// so the rest of the app is unchanged.
(function () {
    const NH = (window.NH = window.NH || {});
    const { cosineDistance } = NH;

    const DB_NAME = 'notehelper';
    const DB_VERSION = 1;
    const EMBED_BATCH = 100; // batchEmbedContents request cap

    let _dbPromise = null;
    function db() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains('documents')) {
                    d.createObjectStore('documents', { keyPath: 'doc_id' });
                }
                if (!d.objectStoreNames.contains('chunks')) {
                    const cs = d.createObjectStore('chunks', { keyPath: 'id' });
                    cs.createIndex('doc_id', 'doc_id', { unique: false });
                }
                if (!d.objectStoreNames.contains('chats')) {
                    d.createObjectStore('chats', { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return _dbPromise;
    }

    function tx(store, mode) {
        return db().then((d) => d.transaction(store, mode).objectStore(store));
    }

    function reqAsync(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function getAll(store, query) {
        return tx(store, 'readonly').then((os) => reqAsync(os.getAll(query)));
    }

    // ---- documents ----
    async function addDocument(docId, filename, summary, chunks) {
        if (!chunks.length) return;
        // embed all chunk texts in batches
        const embeddings = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
            const batch = chunks.slice(i, i + EMBED_BATCH).map((c) => c.text);
            embeddings.push(...(await NH.gemini.embed(batch)));
        }
        const d = await db();
        await new Promise((resolve, reject) => {
            const t = d.transaction(['chunks', 'documents'], 'readwrite');
            const cs = t.objectStore('chunks');
            chunks.forEach((c, i) => {
                cs.put({
                    id: `${docId}_${c.chunk_idx}`,
                    doc_id: c.doc_id,
                    filename: c.filename,
                    page: c.page,
                    chunk_idx: c.chunk_idx,
                    text: c.text,
                    embedding: embeddings[i],
                });
            });
            t.objectStore('documents').put({
                doc_id: docId,
                filename,
                summary,
                num_chunks: chunks.length,
                created_at: Date.now() / 1000,
            });
            t.oncomplete = resolve;
            t.onerror = () => reject(t.error);
        });
    }

    async function listDocuments() {
        const docs = await getAll('documents');
        return docs.sort((a, b) => a.created_at - b.created_at);
    }

    async function getDocument(docId) {
        return tx('documents', 'readonly').then((os) => reqAsync(os.get(docId)));
    }

    async function deleteDocument(docId) {
        const doc = await getDocument(docId);
        if (!doc) return false;
        const d = await db();
        await new Promise((resolve, reject) => {
            const t = d.transaction(['chunks', 'documents'], 'readwrite');
            const idx = t.objectStore('chunks').index('doc_id');
            const cursorReq = idx.openCursor(IDBKeyRange.only(docId));
            cursorReq.onsuccess = () => {
                const cur = cursorReq.result;
                if (cur) { cur.delete(); cur.continue(); }
            };
            t.objectStore('documents').delete(docId);
            t.oncomplete = resolve;
            t.onerror = () => reject(t.error);
        });
        return true;
    }

    // ---- retrieval ----
    // Returns chunks with text + metadata + cosine `distance` (smaller = closer),
    // matching the old retrieve() shape so _prepare_chunks ordering still works.
    async function retrieve(query, docIds, k = 4) {
        const [qVec] = await NH.gemini.embed([query]);
        let candidates;
        if (docIds && docIds.length) {
            // filter by doc_id via the chunks index, one lookup per routed doc
            candidates = [].concat(...(await Promise.all(docIds.map(byDocId))));
        } else {
            candidates = await getAll('chunks');
        }
        const scored = candidates.map((c) => ({
            id: c.id,
            text: c.text,
            doc_id: c.doc_id,
            filename: c.filename,
            page: c.page,
            chunk_idx: c.chunk_idx,
            distance: c.embedding ? cosineDistance(qVec, c.embedding) : 1,
        }));
        scored.sort((a, b) => a.distance - b.distance);
        return scored.slice(0, k);
    }

    function byDocId(docId) {
        return tx('chunks', 'readonly').then(
            (os) => reqAsync(os.index('doc_id').getAll(IDBKeyRange.only(docId)))
        );
    }

    // ---- chat history (used by features in script.js) ----
    async function saveChatTurn(turn) {
        const os = await tx('chats', 'readwrite');
        return reqAsync(os.add({ ...turn, ts: Date.now() }));
    }
    async function listChatTurns() {
        const turns = await getAll('chats');
        return turns.sort((a, b) => a.ts - b.ts);
    }
    async function clearChatTurns() {
        const os = await tx('chats', 'readwrite');
        return reqAsync(os.clear());
    }

    NH.store = {
        addDocument, listDocuments, getDocument, deleteDocument, retrieve,
        saveChatTurn, listChatTurns, clearChatTurns,
    };
})();
