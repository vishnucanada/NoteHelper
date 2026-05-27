"""LangGraph state machine for multi-document RAG.

Phase 1: router -> parallel retrievers -> synthesizer.
Later phases extend this graph (critic loop, external tools).
"""
import json
import operator
import re
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from gemini_ai import ask_gemini
from vectorstore import list_documents, retrieve


class AgentState(TypedDict, total=False):
    question: str
    doc_ids: list[str]                          # routed docs
    chunks: Annotated[list[dict], operator.add] # accumulated across retrievers
    answer: str
    consulted: list[dict]                       # {doc_id, filename} actually consulted


def _strip_fences(text: str) -> str:
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()


def router_node(state: AgentState) -> dict:
    """Pick which documents are relevant. Falls back to all docs if uncertain."""
    docs = list_documents()
    if not docs:
        return {"doc_ids": []}
    if len(docs) == 1:
        return {"doc_ids": [docs[0]["doc_id"]]}

    catalog = "\n".join(
        f"- doc_id={d['doc_id']} | filename={d['filename']} | "
        f"summary={(d.get('summary') or {}).get('one_sentence_explanation', '')}"
        for d in docs
    )
    prompt = (
        "You are a router that picks relevant documents for a question.\n"
        "Return ONLY a JSON array of doc_id strings, no prose, no code fences.\n"
        "If unsure, include more rather than fewer.\n\n"
        f"Available documents:\n{catalog}\n\n"
        f"Question: {state['question']}\n\n"
        "JSON array of doc_ids:"
    )
    try:
        raw = _strip_fences(ask_gemini(prompt))
        picked = json.loads(raw)
        valid = {d["doc_id"] for d in docs}
        picked = [d for d in picked if d in valid]
        if not picked:
            picked = [d["doc_id"] for d in docs]
    except Exception:
        picked = [d["doc_id"] for d in docs]
    return {"doc_ids": picked}


def fan_out_to_retrievers(state: AgentState):
    if not state.get("doc_ids"):
        return [Send("retriever", {"question": state["question"], "doc_id": None})]
    return [
        Send("retriever", {"question": state["question"], "doc_id": d})
        for d in state["doc_ids"]
    ]


def retriever_node(payload: dict) -> dict:
    """Retrieve top-k chunks from one document (or all if doc_id is None)."""
    doc_ids = [payload["doc_id"]] if payload.get("doc_id") else None
    chunks = retrieve(payload["question"], doc_ids=doc_ids, k=4)
    return {"chunks": chunks}


def synthesizer_node(state: AgentState) -> dict:
    chunks = state.get("chunks", [])
    if not chunks:
        return {
            "answer": "I couldn't find anything in your library that addresses this question.",
            "consulted": [],
        }
    consulted_seen: set[str] = set()
    consulted: list[dict] = []
    for c in chunks:
        if c["doc_id"] not in consulted_seen:
            consulted_seen.add(c["doc_id"])
            consulted.append({"doc_id": c["doc_id"], "filename": c["filename"]})

    context_block = "\n\n".join(
        f"[chunk {i+1} | {c['filename']} p.{c['page']}]\n{c['text']}"
        for i, c in enumerate(chunks)
    )
    prompt = (
        "Answer the question using ONLY the provided document chunks.\n"
        "Return ONLY valid JSON (no markdown, no code fences) with one key 'answer'.\n"
        "If the chunks do not contain the answer, say so plainly in the answer field.\n\n"
        f"Chunks:\n{context_block}\n\n"
        f"Question: {state['question']}\n\n"
        "JSON:"
    )
    try:
        raw = _strip_fences(ask_gemini(prompt))
        try:
            answer = json.loads(raw).get("answer", raw)
        except json.JSONDecodeError:
            answer = raw
    except Exception as e:
        answer = f"Error generating answer: {e}"
    return {"answer": answer, "consulted": consulted}


def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router", router_node)
    g.add_node("retriever", retriever_node)
    g.add_node("synthesizer", synthesizer_node)
    g.add_edge(START, "router")
    g.add_conditional_edges("router", fan_out_to_retrievers, ["retriever"])
    g.add_edge("retriever", "synthesizer")
    g.add_edge("synthesizer", END)
    return g.compile()


_compiled = build_graph()


def answer_question(question: str) -> dict:
    """Run the full graph for a single question."""
    final = _compiled.invoke({"question": question, "chunks": []})
    return {
        "answer": final.get("answer", ""),
        "consulted": final.get("consulted", []),
        "chunks": final.get("chunks", []),
        "routed_doc_ids": final.get("doc_ids", []),
    }
