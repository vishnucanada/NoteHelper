# Note Helper 🤖📝

**Note Helper** is an agentic, multi-document study assistant. Upload an entire semester of PDFs and ask questions across your whole library — a LangGraph state machine routes each question to the relevant documents, retrieves the right chunks from a vector store, and synthesizes a grounded answer.

Built on **LangGraph + ChromaDB + Gemini**.

## ✨ Features

- **Multi-Document Library:** Upload as many PDFs as you want. Each one is chunked, embedded with `gemini-embedding-001`, and persisted to a local ChromaDB vector store.
- **Router Agent:** Every question first hits a router node that reads the catalog of uploaded docs and picks the relevant subset. Off-topic queries fall back to the full library; specific queries are routed surgically.
- **Parallel Retrieval (Send fan-out):** The router dispatches one retriever node per selected document via LangGraph's `Send` API. Each retriever pulls top-k chunks for its doc in parallel.
- **Inline Citations + Self-Correcting Critic Loop:** The generator emits answers with inline `[N]` citation tags. A critic node verifies each cited claim against its chunk; if any claim fails, a query rewriter refines the search and the graph loops back to retrieval (capped at 2 retries).
- **Live SSE Streaming:** Each graph node emits a Server-Sent Event as it completes, so the UI animates the agent's progress in real time — routing → retrieving → generating → verifying — with retry indicators when the critic forces another pass.
- **LangSmith-Ready:** Set `LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY` in `.env` and every graph run is traced automatically — no code changes needed.
- **Per-Document Summaries:** On upload, Gemini generates a one-sentence explanation, brief summary, and key takeaways — all persisted alongside the chunks.
- **Library Management UI:** See every doc you've uploaded, expand summaries inline, and delete docs you no longer need.
- **Consulted-Doc Badges + Citation Evidence:** Every answer shows which documents the router consulted, a verified/best-effort badge from the critic, and a foldable list of citation evidence (claim + chunk + supported/unsupported verdict).

## 🏗️ Architecture

```
                          ┌─────────────────────┐
       Upload PDF ───────▶│ Chunker (page-aware)│
                          └─────────┬───────────┘
                                    ▼
                          ┌─────────────────────┐
                          │  Gemini Embeddings  │
                          └─────────┬───────────┘
                                    ▼
                          ┌─────────────────────┐
                          │  ChromaDB Library   │
                          └─────────────────────┘

  Q ─▶ Router ─┬─▶ Retriever(doc_a) ─┐
               ├─▶ Retriever(doc_b) ─┼─▶ Generator ─▶ Critic ──pass──▶ Answer
               └─▶ Retriever(doc_c) ─┘                   │
                                                         └──fail──▶ Rewriter
                                                                     │
                                                                     ▼
                                                                 (loop back to Retriever)
                                                                  max 2 retries
```

State flows through a LangGraph `StateGraph` (`backend/graph.py`):
- `router_node` — Gemini picks `doc_ids` based on doc summaries.
- `retriever_node` — runs once per routed doc (parallel via `Send`); writes chunks back to shared state.
- `generator_node` — produces the answer with inline `[N]` citation tags keyed to retrieved chunks.
- `critic_node` — for each cited claim, asks Gemini whether the referenced chunk explicitly supports it. Bumps `retry_count` on failure.
- `query_rewriter_node` — given the failed claims, rewrites the retrieval query to better target the missing evidence.
- Conditional edge from `critic` → `END` if verified or retry cap reached, else → `rewriter` → `retriever` (re-fans out with the new query).

Every node emits an SSE event as it completes, so the frontend can render the trace live.

## 📂 Project Structure

```
NoteHelper/
├── backend/
│   ├── endpoint.py     # Flask routes: /message, /documents, /followup
│   ├── chunker.py      # PDF → page-aware chunks (1000 chars, 200 overlap)
│   ├── vectorstore.py  # ChromaDB persistent client + Gemini embedding fn
│   ├── graph.py        # LangGraph router → retrievers → synthesizer
│   └── gemini_ai.py    # Gemini client + summarization
├── frontend/
│   ├── index.html      # Upload, library, Q&A panels
│   ├── script.js       # Multi-upload queue, library refresh, Q&A
│   └── style.css
├── chroma_db/          # Persistent vector store (gitignored)
└── requirements.txt
```

## 🛠️ How It Works

1. **Ingest.** A PDF is split per page, then each page is recursively chunked (1000 chars, 200 overlap). Each chunk carries `{doc_id, filename, page, chunk_idx}` metadata.
2. **Embed.** Chunks are embedded via the Gemini Embeddings API (`gemini-embedding-001`) using a custom ChromaDB `EmbeddingFunction`, then stored in the persistent `library` collection.
3. **Summarize.** Gemini produces a one-liner + brief summary + key takeaways for the doc, stored in a sidecar `documents.json` index.
4. **Route.** A user question hits the LangGraph router. The router sees `{doc_id, filename, one_sentence_explanation}` for every doc and returns a JSON array of `doc_ids` to query.
5. **Retrieve.** The router fans out via `Send` to one retriever node per selected doc. Each retriever does a top-k similarity search filtered by `doc_id`.
6. **Synthesize.** The synthesizer node receives all retrieved chunks (deduplicated by source), prompts Gemini with the chunks + question, and returns the answer plus the list of documents consulted.

## 🔌 API

| Method | Path                  | Purpose                                    |
| ------ | --------------------- | ------------------------------------------ |
| POST   | `/message`            | Upload a PDF — chunks, embeds, summarizes. |
| GET    | `/documents`          | List all docs in the library.              |
| DELETE | `/documents/<doc_id>` | Remove a doc and its chunks.               |
| POST   | `/followup`           | **SSE stream** — one event per graph node. |
| POST   | `/followup/sync`      | Non-streaming fallback (single JSON).      |

`/followup` returns `text/event-stream`. Each frame is `data: { ... }\n\n` where the payload's `node` field tells you what just fired:

```
data: {"node":"router","doc_ids":["..."],"query":"..."}
data: {"node":"retriever","chunks_added":4}
data: {"node":"generator","answer":"... [1] ... [2] ...","consulted":[...]}
data: {"node":"critic","verified":true,"citations":[{"n":1,"claim":"...","supported":true,"reason":"...","filename":"...","page":3}],"retry_count":0}
data: {"node":"done"}
```

`/followup/sync` returns the same shape compressed into a single JSON response under `data`.

## 📦 Installation & Local Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/vishnucanada/note-helper.git
   cd note-helper
   ```

2. **Set up your `.env`** in the project root with your Gemini API key:
   ```env
   GEMINI_API_KEY=your_google_gemini_api_key_here

   # Optional — enable LangSmith tracing for the agentic graph
   # LANGCHAIN_TRACING_V2=true
   # LANGCHAIN_API_KEY=ls__your_langsmith_key
   # LANGCHAIN_PROJECT=NoteHelper
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```
   > Note: `langgraph` is pinned to `<1.0` because the 1.x release pulls in `langchain-protocol`, which requires Python 3.13+. On Python 3.12 the pinned version works cleanly.

4. **Start the backend:**
   ```bash
   python3 backend/endpoint.py
   ```

5. **Serve the frontend** (VS Code Live Server on port `5500` is what CORS is configured for), or open `frontend/index.html` directly.

6. Upload a few PDFs, then ask questions across them in the Q&A panel.

## 🔮 Roadmap

Phase 1 (multi-doc librarian with router agent) ✅
Phase 2 (self-correcting citation critic loop + SSE streaming + LangSmith) ✅
Phase 3 — **next**: knowledge-gap finder + ReAct external tools. When the critic still can't verify after retries on internal docs, the agent decides whether to call Gemini grounded search, Wikipedia, or arXiv, and merges external evidence into the answer.
