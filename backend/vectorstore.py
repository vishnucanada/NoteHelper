import json
import os
import time
from pathlib import Path

import chromadb
from chromadb import Documents, EmbeddingFunction, Embeddings
from dotenv import load_dotenv
from google import genai

load_dotenv()

_PERSIST_DIR = Path(__file__).parent.parent / "chroma_db"
_PERSIST_DIR.mkdir(exist_ok=True)
_DOC_INDEX_PATH = _PERSIST_DIR / "documents.json"
_COLLECTION_NAME = "library"
_EMBED_MODEL = "gemini-embedding-001"

_gemini = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


class GeminiEmbedder(EmbeddingFunction):
    def __call__(self, input: Documents) -> Embeddings:
        # google-genai batches via contents=list[str]
        result = _gemini.models.embed_content(
            model=_EMBED_MODEL,
            contents=list(input),
        )
        return [e.values for e in result.embeddings]


_client = chromadb.PersistentClient(path=str(_PERSIST_DIR))
_collection = _client.get_or_create_collection(
    name=_COLLECTION_NAME,
    embedding_function=GeminiEmbedder(),
)


def _load_index() -> dict:
    if not _DOC_INDEX_PATH.exists():
        return {}
    return json.loads(_DOC_INDEX_PATH.read_text())


def _save_index(index: dict) -> None:
    _DOC_INDEX_PATH.write_text(json.dumps(index, indent=2))


def add_document(doc_id: str, filename: str, summary: dict, chunks: list[dict]) -> None:
    if not chunks:
        return
    _collection.add(
        ids=[f"{doc_id}_{c['chunk_idx']}" for c in chunks],
        documents=[c["text"] for c in chunks],
        metadatas=[
            {
                "doc_id": c["doc_id"],
                "filename": c["filename"],
                "page": c["page"],
                "chunk_idx": c["chunk_idx"],
            }
            for c in chunks
        ],
    )
    index = _load_index()
    index[doc_id] = {
        "doc_id": doc_id,
        "filename": filename,
        "summary": summary,
        "num_chunks": len(chunks),
        "created_at": time.time(),
    }
    _save_index(index)


def list_documents() -> list[dict]:
    index = _load_index()
    return sorted(index.values(), key=lambda d: d["created_at"])


def get_document(doc_id: str) -> dict | None:
    return _load_index().get(doc_id)


def delete_document(doc_id: str) -> bool:
    index = _load_index()
    if doc_id not in index:
        return False
    _collection.delete(where={"doc_id": doc_id})
    del index[doc_id]
    _save_index(index)
    return True


def retrieve(query: str, doc_ids: list[str] | None = None, k: int = 4) -> list[dict]:
    """Return list of chunks with text + metadata + similarity score."""
    kwargs = {"query_texts": [query], "n_results": k}
    if doc_ids:
        if len(doc_ids) == 1:
            kwargs["where"] = {"doc_id": doc_ids[0]}
        else:
            kwargs["where"] = {"doc_id": {"$in": doc_ids}}
    result = _collection.query(**kwargs)
    out: list[dict] = []
    if not result["ids"] or not result["ids"][0]:
        return out
    for i, chunk_id in enumerate(result["ids"][0]):
        meta = result["metadatas"][0][i]
        out.append({
            "id": chunk_id,
            "text": result["documents"][0][i],
            "doc_id": meta["doc_id"],
            "filename": meta["filename"],
            "page": meta["page"],
            "chunk_idx": meta["chunk_idx"],
            "distance": result["distances"][0][i] if result.get("distances") else None,
        })
    return out
