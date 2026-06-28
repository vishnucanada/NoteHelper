// Shared config + small helpers. Mirrors the constants and the _strip_fences /
// JSON-parse pattern that were duplicated across the old Python backend
// (graph.py, endpoint.py, tools.py) — now a single source of truth.
(function () {
    // globalThis === window in the browser; using it lets the same file load
    // under Node for tests without a DOM.
    const root = typeof globalThis !== 'undefined' ? globalThis : window;
    const NH = (root.NH = root.NH || {});

    NH.config = {
        // Generation + embedding models (were hard-coded in gemini_ai.py / vectorstore.py)
        MODEL: 'gemini-2.5-flash',
        EMBED_MODEL: 'gemini-embedding-001',
        // Agent loop bounds (were graph.py:21-23)
        MAX_RETRIES: 2,        // critic loop cap (3 generator passes total)
        MAX_SUBQ: 4,           // planner won't decompose into more than this
        MAX_CONTEXT_CHUNKS: 12, // cap chunks fed to the generator after fan-out
        // External tools
        ENABLE_ARXIV: false,   // arXiv export API sends no CORS headers; off by default
        SUMMARY_TEXT_LIMIT: 10000, // mirrors summarize_this truncation
        EXTERNAL_TEXT_LIMIT: 1500, // mirrors _external_chunk text cap
    };

    // Strip ```json ... ``` fences a model sometimes wraps JSON in.
    // (was _strip_fences in graph.py:42, _clean_json in endpoint.py:33, tools.py:27)
    NH.stripFences = function stripFences(text) {
        return String(text || '')
            .trim()
            .replace(/^```(?:json)?\s*/gm, '')
            .replace(/\s*```$/gm, '')
            .trim();
    };

    // Parse model JSON leniently: strip fences, JSON.parse, fall back on failure.
    NH.safeJson = function safeJson(raw, fallback = null) {
        try {
            return JSON.parse(NH.stripFences(raw));
        } catch (_) {
            return fallback;
        }
    };

    // Cosine distance in [0, 2] so smaller = more similar, matching Chroma's
    // default distance semantics that retrieve()/_prepare_chunks sort on.
    NH.cosineDistance = function cosineDistance(a, b) {
        let dot = 0, na = 0, nb = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0) return 1;
        return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
    };
})();
