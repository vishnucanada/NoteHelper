// Direct browser calls to the Gemini REST API. Replaces backend/gemini_ai.py and
// the embedding half of backend/vectorstore.py. Uses the user's own key from
// apikey.js. The Generative Language API supports CORS, so fetch works from a
// static page.
(function () {
    const NH = (window.NH = window.NH || {});
    const { config, safeJson } = NH;
    const BASE = 'https://generativelanguage.googleapis.com/v1beta';

    function keyError(status, body) {
        if (status === 400 || status === 403) {
            return new Error('Gemini rejected the request (check your API key is valid and enabled). ' + body);
        }
        if (status === 429) {
            return new Error('Gemini rate limit / quota exceeded. Wait a moment and retry. ' + body);
        }
        return new Error(`Gemini API error ${status}: ${body}`);
    }

    async function postJson(path, payload) {
        const key = NH.apikey.require(); // throws MissingKeyError if absent
        const res = await fetch(`${BASE}/${path}?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            let body = '';
            try { body = (await res.json())?.error?.message || ''; } catch (_) {}
            throw keyError(res.status, body);
        }
        return res.json();
    }

    // Single-prompt text generation. (was ask_gemini)
    async function askGemini(prompt, model) {
        const data = await postJson(`models/${model || config.MODEL}:generateContent`, {
            contents: [{ parts: [{ text: prompt }] }],
        });
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || '').join('');
    }

    // Batch-embed an array of texts -> array of vectors. (was GeminiEmbedder)
    async function embed(texts) {
        if (!texts.length) return [];
        const model = `models/${config.EMBED_MODEL}`;
        const data = await postJson(`${model}:batchEmbedContents`, {
            requests: texts.map((t) => ({
                model,
                content: { parts: [{ text: t }] },
            })),
        });
        return (data.embeddings || []).map((e) => e.values);
    }

    // Per-document summary on upload. (was summarize_this) Returns a parsed object
    // with the same keys the UI expects, with a graceful fallback.
    async function summarizeThis(text) {
        const prompt =
            'Summarize this document and return ONLY valid JSON (no markdown, no code fences). ' +
            'JSON structure must have these exact keys: one_sentence_explanation, brief_summary, key_take_aways. ' +
            'one_sentence_explanation: one concise sentence, ' +
            'brief_summary: 2-3 paragraph summary, ' +
            'key_take_aways: bullet points of main points. ' +
            `Document text: ${text.slice(0, config.SUMMARY_TEXT_LIMIT)}`;
        try {
            const raw = await askGemini(prompt);
            return (
                safeJson(raw) || {
                    one_sentence_explanation: '(summary unavailable)',
                    brief_summary: raw.slice(0, 500),
                    key_take_aways: '',
                }
            );
        } catch (e) {
            return {
                error: `AI service error: ${e.message}`,
                one_sentence_explanation: 'Failed to generate summary',
                brief_summary: 'There was an error processing your document',
                key_take_aways: 'Please try again or check your API key',
            };
        }
    }

    NH.gemini = { askGemini, embed, summarizeThis };
})();
