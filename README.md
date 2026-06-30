# Note Helper 

[![CI](https://github.com/vishnucanada/NoteHelper/actions/workflows/ci.yml/badge.svg)](https://github.com/vishnucanada/NoteHelper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Note Helper** is an agentic, multi-document study assistant that runs **entirely in your browser**. Upload an entire semester of PDFs and ask questions across your whole library — an in-browser agent routes each question to the relevant documents, retrieves the right chunks from a local vector store, and synthesizes a grounded, cited answer.

No backend, no server, no hosting bill. The app is fully static (deployable to **GitHub Pages**) and calls the **Gemini API directly with your own key**, which is stored only in your browser.

**▶︎ Live demo:** [vishnucanada.github.io/NoteHelper](https://vishnucanada.github.io/NoteHelper/) — bring your own free [Gemini key](https://aistudio.google.com/apikey).

> Built on **vanilla JS + IndexedDB + pdf.js + Gemini**. The original Flask/LangGraph/ChromaDB server lives in [`legacy/`](legacy/) for reference.

## Features

- **100% client-side & private:** PDFs never leave your machine. Parsing, embeddings, vector search, and the agent loop all run in the browser; only Gemini API calls go out, using *your* key.
- **Multi-document library:** Upload as many PDFs as you want (up to 25 MB each). Each is parsed with pdf.js, chunked, embedded with `gemini-embedding-001`, and persisted to **IndexedDB**. A per-file progress bar tracks the *extracting* and *embedding* stages, and any document can be deleted from the library with one click.
- **Router agent:** Each question first hits a router that reads your doc summaries and picks the relevant subset (falls back to the full library when unsure).
- **Parallel retrieval:** A planner decomposes multi-hop questions; retrieval fans out over (sub-question × routed doc) in parallel and ranks chunks by cosine similarity.
- **Inline citations + self-correcting critic loop:** The generator emits `[N]` citation tags; a critic verifies each claim against its chunk and, on failure, a rewriter refines the query and loops back (capped at 2 retries).
- **ReAct external fallback:** When the library still can't verify, the agent reaches out to **Wikipedia** (arXiv optional — see CORS note) and merges the evidence for one more pass.
- **Live agent trace:** The UI animates routing → retrieving → generating → verifying in real time, with retry indicators — driven by local events (no SSE needed anymore).
- **Persisted chat history:** Q&A turns are saved to IndexedDB and restored on reload.
- **Quiz generation & Markdown export:** Generate study questions per document, and copy any answer (with citations) as Markdown.

## Architecture (backendless)

```
  Browser only (static page on GitHub Pages)
  ────────────────────────────────────────────
  Upload PDF ─▶ pdf.js extract ─▶ chunk ─▶ Gemini embeddings ─▶ IndexedDB

  Q ─▶ planner ─▶ router ─┬─▶ retrieve(doc_a) ─┐
                          ├─▶ retrieve(doc_b) ─┼─▶ generator ─▶ critic ──pass──▶ Answer
                          └─▶ retrieve(doc_c) ─┘                  │
                                                       fail (≤2)  ├──▶ rewriter ─▶ (re-retrieve)
                                                       retries up  └──▶ external tools (Wikipedia) ─▶ (re-generate)
```

The agent (`lib/agent.js`) runs the same pipeline the old LangGraph server did, emitting the same event objects the UI already knew how to render.

## Configuration

Runtime knobs live in `lib/util.js` (`NH.config`); `config.js` wires up the pdf.js
worker and overrides any deployment-specific flags. The defaults:

| Key | Default | What it controls |
| --- | --- | --- |
| `MODEL` | `gemini-2.5-flash` | Generation model for the agent loop |
| `EMBED_MODEL` | `gemini-embedding-001` | Embedding model for chunks and queries |
| `MAX_RETRIES` | `2` | Critic-loop cap (3 generator passes total) |
| `MAX_SUBQ` | `4` | Most sub-questions the planner may decompose into |
| `MAX_CONTEXT_CHUNKS` | `12` | Chunks fed to the generator after fan-out |
| `ENABLE_ARXIV` | `false` | Use arXiv as an external tool (see the CORS note below) |
| `SUMMARY_TEXT_LIMIT` | `10000` | Chars of a doc sent to the summarizer |
| `EXTERNAL_TEXT_LIMIT` | `1500` | Chars kept per external-tool result |

UI-side limits live in `script.js`: PDFs are capped at **25 MB** each and questions at
**2000 characters**.

## Project Structure

```
NoteHelper/                   # the static app lives at the repo root
├── index.html
├── script.js                 # UI: upload, library, Q&A, history, quiz, export
├── config.js                 # pdf.js worker + feature flags
├── style.css
├── lib/
│   ├── util.js               # config constants, stripFences, safeJson, cosine
│   ├── apikey.js             # Gemini key in localStorage + modal
│   ├── gemini.js             # Gemini REST: askGemini, embed, summarizeThis
│   ├── chunker.js            # pdf.js extraction + recursive splitter
│   ├── store.js              # IndexedDB vector store + chat history
│   ├── tools.js              # Wikipedia / arXiv external tools
│   └── agent.js              # planner→router→retrieve→generator→critic→rewriter/external
├── .github/workflows/pages.yml   # GitHub Pages deploy
└── legacy/                   # archived Flask/LangGraph/ChromaDB server (reference)
```

## Run it locally

The app must be served over **http** (not `file://`) so pdf.js workers and IndexedDB work:

```bash
# from the repo root
python3 -m http.server 5500
# then open http://localhost:5500
```

On first load you'll be prompted for a **Gemini API key** (get one free at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey)). It's stored only in
your browser's `localStorage`. Upload a few PDFs, then ask away.

> Tip: in the Google console, restrict your API key to an HTTP referrer (your Pages
> domain) so it can't be reused elsewhere.

## Deploy to GitHub Pages

The app sits at the repo root, so either deploy path works:

- **Deploy from a branch:** Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`.
- **GitHub Actions:** Settings → Pages → Source: *GitHub Actions* (the included `.github/workflows/pages.yml` publishes the repo root on every push to `main`).

Then open `https://<user>.github.io/<repo>/` and add your key. No Fly.io, no Vercel, no container.

## Development

The app ships as plain static files — no build step is needed to run it. Tooling is
only for quality checks:

```bash
npm install        # dev tooling (Vitest, ESLint, Prettier)
npm test           # unit tests for the pure logic (splitter, cosine, citation parsing)
npm run lint       # ESLint over lib/, script.js, config.js
npm run format     # Prettier (optional; not enforced in CI)
```

- **Tests** ([`test/`](test/)) cover the algorithmic core: the recursive character
  splitter (`lib/chunker.js`), cosine distance / JSON helpers (`lib/util.js`), and the
  citation parsing + chunk-prep used by the critic (`lib/agent.js`). The browser modules
  expose these pure helpers under a Node-only `module.exports` guard so they can be unit
  tested without a DOM.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint + tests on
  every push and PR; [`pages.yml`](.github/workflows/pages.yml) deploys to GitHub Pages.

## Notes

- **arXiv CORS:** `export.arxiv.org` sends no CORS headers, so the external-tools branch uses **Wikipedia** by default. Flip `ENABLE_ARXIV` in `config.js` only if you proxy arXiv through a CORS-enabled host.
- **Your key, your quota:** every user brings their own Gemini key; there's no shared server-side secret.
- **Retrieval quality:** chunks are embedded with `taskType=RETRIEVAL_DOCUMENT` and queries with `RETRIEVAL_QUERY`; the fan-out embeds each unique sub-question once and reuses the vector across routed documents.
