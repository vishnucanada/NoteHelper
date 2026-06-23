# Legacy server (archived)

NoteHelper used to run as a Flask backend (LangGraph + ChromaDB + Gemini) deployed
on Fly.io, with the frontend on Vercel. The app is now **fully backendless** — all
of this logic was ported into the browser under `frontend/lib/` and the app calls
the Gemini API directly with the user's own key.

These files are kept only as reference for the original server architecture:

- `backend/` — Flask API, LangGraph state machine, ChromaDB vector store, Gemini wrappers, external tools
- `Dockerfile`, `.dockerignore`, `fly.toml` — Fly.io container deploy
- `vercel.json` — Vercel static frontend deploy
- `requirements.txt` — Python deps
- `DEPLOY.md` — old deployment guide

The browser ports map 1:1 to these modules:

| Legacy (Python) | New (browser) |
|---|---|
| `backend/gemini_ai.py` | `frontend/lib/gemini.js` |
| `backend/vectorstore.py` (+ ChromaDB) | `frontend/lib/store.js` (IndexedDB) |
| `backend/chunker.py` | `frontend/lib/chunker.js` (pdf.js) |
| `backend/tools.py` | `frontend/lib/tools.js` |
| `backend/graph.py` (+ SSE in `endpoint.py`) | `frontend/lib/agent.js` |

> Note: `.env` (the old server-side `GEMINI_API_KEY`) is no longer used. It was
> git-ignored and never committed. If that key was ever shared, rotate it in the
> Google AI Studio console — the backendless app uses a per-user key instead.
