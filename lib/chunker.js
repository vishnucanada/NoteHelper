// PDF extraction + page-aware recursive chunking, in the browser. Replaces
// backend/chunker.py (PyPDF2 + LangChain RecursiveCharacterTextSplitter).
// Uses pdf.js, loaded from a CDN <script> in index.html (global: pdfjsLib).
(function () {
    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const NH = (root.NH = root.NH || {});

    const CHUNK_SIZE = 1000;
    const CHUNK_OVERLAP = 200;
    const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

    function newDocId() {
        // 12 hex chars, matching new_doc_id()
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    // ---- recursive character splitter (faithful to LangChain's algorithm) ----
    function mergeSplits(splits, sep, size, overlap) {
        const sepLen = sep.length;
        const out = [];
        let current = [];
        let total = 0;
        for (const d of splits) {
            const len = d.length;
            if (total + len + (current.length ? sepLen : 0) > size && current.length) {
                out.push(current.join(sep));
                while (
                    total > overlap ||
                    (total + len + (current.length ? sepLen : 0) > size && total > 0)
                ) {
                    total -= current[0].length + (current.length > 1 ? sepLen : 0);
                    current.shift();
                }
            }
            current.push(d);
            total += len + (current.length > 1 ? sepLen : 0);
        }
        if (current.length) out.push(current.join(sep));
        return out.filter((c) => c.trim());
    }

    function splitText(text, separators) {
        const finalChunks = [];
        let separator = separators[separators.length - 1];
        let rest = [];
        for (let i = 0; i < separators.length; i++) {
            const s = separators[i];
            if (s === '') { separator = ''; break; }
            if (text.includes(s)) { separator = s; rest = separators.slice(i + 1); break; }
        }
        const splits = separator ? text.split(separator) : text.split('');
        let good = [];
        for (const s of splits) {
            if (s.length < CHUNK_SIZE) {
                good.push(s);
            } else {
                if (good.length) {
                    finalChunks.push(...mergeSplits(good, separator, CHUNK_SIZE, CHUNK_OVERLAP));
                    good = [];
                }
                if (!rest.length) finalChunks.push(s);
                else finalChunks.push(...splitText(s, rest));
            }
        }
        if (good.length) finalChunks.push(...mergeSplits(good, separator, CHUNK_SIZE, CHUNK_OVERLAP));
        return finalChunks;
    }

    // ---- PDF extraction ----
    async function extractPages(file) {
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('pdf.js failed to load (check your network/CDN).');
        }
        const data = new Uint8Array(await file.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        const pages = [];
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            pages.push(content.items.map((it) => it.str).join(' '));
        }
        return pages;
    }

    // Returns { chunks, fullText }. Each chunk: {doc_id, filename, page, chunk_idx, text}
    async function chunkPdf(file, docId, filename) {
        const pages = await extractPages(file);
        const chunks = [];
        let idx = 0;
        pages.forEach((pageText, i) => {
            if (!pageText.trim()) return;
            for (const piece of splitText(pageText, SEPARATORS)) {
                chunks.push({
                    doc_id: docId,
                    filename,
                    page: i + 1,
                    chunk_idx: idx,
                    text: piece,
                });
                idx += 1;
            }
        });
        return { chunks, fullText: pages.join('\n') };
    }

    NH.chunker = { newDocId, extractPages, chunkPdf, splitText };

    // Node/test export (no-op in the browser). Exposes the pure splitter helpers.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { splitText, mergeSplits, CHUNK_SIZE, CHUNK_OVERLAP, SEPARATORS };
    }
})();
