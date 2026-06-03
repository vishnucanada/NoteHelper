"""LangGraph state machine for multi-document RAG.

Phase 1: router -> parallel retrievers -> synthesizer.
Phase 2: generator emits [N] citations -> critic verifies -> rewriter loops on failure.
"""
import json
import operator
import re
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from gemini_ai import ask_gemini
from vectorstore import list_documents, retrieve


MAX_RETRIES = 2  # critic loop cap (3 generator passes total: initial + 2 retries)


class AgentState(TypedDict, total=False):
    question: str                                   # original user question (immutable)
    query: str                                      # current retrieval query (rewritten across retries)
    doc_ids: list[str]                              # routed docs
    chunks: Annotated[list[dict], operator.add]     # accumulated across retries / parallel retrievers
    answer: str
    citations: list[dict]                           # [{n, claim, chunk_id, supported, reason}]
    verified: bool
    retry_count: int
    consulted: list[dict]                           # [{doc_id, filename}]
    failed_claims: list[dict]


def _strip_fences(text: str) -> str:
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()


def _dedupe_chunks(chunks: list[dict]) -> list[dict]:
    seen = set()
    out: list[dict] = []
    for c in chunks:
        key = c.get("id") or (c.get("doc_id"), c.get("chunk_idx"))
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


# ----------------------------- nodes -----------------------------

def router_node(state: AgentState) -> dict:
    """Pick which documents are relevant. Falls back to all docs if uncertain."""
    docs = list_documents()
    if not docs:
        return {"doc_ids": [], "query": state.get("query") or state["question"]}
    if len(docs) == 1:
        return {"doc_ids": [docs[0]["doc_id"]], "query": state.get("query") or state["question"]}

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
    return {"doc_ids": picked, "query": state.get("query") or state["question"]}


def fan_out_to_retrievers(state: AgentState):
    """Send the current query to one retriever per routed doc."""
    query = state.get("query") or state["question"]
    if not state.get("doc_ids"):
        return [Send("retriever", {"query": query, "doc_id": None})]
    return [
        Send("retriever", {"query": query, "doc_id": d})
        for d in state["doc_ids"]
    ]


def retriever_node(payload: dict) -> dict:
    """Retrieve top-k chunks from one document (or all if doc_id is None)."""
    doc_ids = [payload["doc_id"]] if payload.get("doc_id") else None
    chunks = retrieve(payload["query"], doc_ids=doc_ids, k=4)
    return {"chunks": chunks}


def generator_node(state: AgentState) -> dict:
    """Generate an answer with inline [N] citations indexed to chunks."""
    chunks = _dedupe_chunks(state.get("chunks", []))
    if not chunks:
        return {
            "answer": "I couldn't find anything in your library that addresses this question.",
            "citations": [],
            "consulted": [],
        }

    # numbered chunks so the model can cite [1], [2], ...
    context_block = "\n\n".join(
        f"[{i+1}] ({c['filename']} p.{c['page']})\n{c['text']}"
        for i, c in enumerate(chunks)
    )
    failed = state.get("failed_claims") or []
    retry_hint = ""
    if failed:
        retry_hint = (
            "\n\nNOTE: A previous attempt failed citation verification on these claims:\n"
            + "\n".join(f"- \"{f['claim']}\" — {f['reason']}" for f in failed)
            + "\nBe more careful this time — only assert what the chunks explicitly support."
        )

    prompt = (
        "Answer the question using ONLY the provided chunks.\n"
        "Every factual claim MUST end with a citation tag like [1], [2], or [1,3].\n"
        "If chunks do not support an answer, say so plainly (no citation needed for that disclaimer).\n"
        "Return ONLY valid JSON with one key 'answer'. No markdown, no code fences.\n\n"
        f"Chunks:\n{context_block}{retry_hint}\n\n"
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

    consulted_seen: set[str] = set()
    consulted: list[dict] = []
    for c in chunks:
        if c["doc_id"] not in consulted_seen:
            consulted_seen.add(c["doc_id"])
            consulted.append({"doc_id": c["doc_id"], "filename": c["filename"]})

    return {"answer": answer, "consulted": consulted}


_CITATION_RE = re.compile(r"\[([\d,\s]+)\]")
# split into sentences on ., !, ? followed by whitespace or end
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


def _extract_claims(answer: str) -> list[dict]:
    """Find every sentence with a [N] tag; return [{claim, chunk_nums}]."""
    claims: list[dict] = []
    for sentence in _SENTENCE_SPLIT_RE.split(answer.strip()):
        nums: list[int] = []
        for m in _CITATION_RE.finditer(sentence):
            for tok in m.group(1).split(","):
                tok = tok.strip()
                if tok.isdigit():
                    nums.append(int(tok))
        if nums:
            claim_text = _CITATION_RE.sub("", sentence).strip()
            claims.append({"claim": claim_text, "chunk_nums": nums})
    return claims


def critic_node(state: AgentState) -> dict:
    """Verify every cited claim actually appears in its referenced chunk."""
    chunks = _dedupe_chunks(state.get("chunks", []))
    answer = state.get("answer", "")
    extracted = _extract_claims(answer)

    if not extracted:
        # nothing to verify; if the answer is a disclaimer that's fine
        is_disclaimer = "could not" in answer.lower() or "don't" in answer.lower() or "do not" in answer.lower() or "couldn't" in answer.lower()
        return {
            "verified": is_disclaimer or not chunks,
            "citations": [],
            "failed_claims": [] if is_disclaimer else [{"claim": answer[:120], "reason": "answer has no [N] citations"}],
            "retry_count": state.get("retry_count", 0) + (0 if is_disclaimer else 1),
        }

    citations: list[dict] = []
    failed: list[dict] = []
    for entry in extracted:
        for n in entry["chunk_nums"]:
            if n < 1 or n > len(chunks):
                failed.append({"claim": entry["claim"], "reason": f"cited chunk [{n}] does not exist"})
                citations.append({"n": n, "claim": entry["claim"], "supported": False, "reason": "out of range"})
                continue
            chunk = chunks[n - 1]
            verdict = _verify_claim(entry["claim"], chunk["text"])
            citations.append({
                "n": n,
                "claim": entry["claim"],
                "chunk_id": chunk.get("id"),
                "filename": chunk["filename"],
                "page": chunk["page"],
                "supported": verdict["supported"],
                "reason": verdict["reason"],
            })
            if not verdict["supported"]:
                failed.append({"claim": entry["claim"], "reason": verdict["reason"]})

    return {
        "verified": len(failed) == 0,
        "citations": citations,
        "failed_claims": failed,
        "retry_count": state.get("retry_count", 0) + (0 if not failed else 1),
    }


def _verify_claim(claim: str, chunk_text: str) -> dict:
    """Ask Gemini whether the chunk explicitly supports the claim."""
    prompt = (
        "You verify factual support. Decide whether the CLAIM is explicitly supported by the CHUNK.\n"
        "Return ONLY valid JSON with keys 'supported' (true/false) and 'reason' (short).\n"
        "Be strict: paraphrase is OK, but the chunk must contain the substance of the claim. "
        "If the chunk is unrelated or missing key facts, set supported=false.\n\n"
        f"CLAIM: {claim}\n\n"
        f"CHUNK: {chunk_text}\n\n"
        "JSON:"
    )
    try:
        raw = _strip_fences(ask_gemini(prompt))
        parsed = json.loads(raw)
        return {
            "supported": bool(parsed.get("supported")),
            "reason": str(parsed.get("reason", ""))[:240],
        }
    except Exception as e:
        # If verification itself fails, be lenient — don't punish the answer for a transient API blip.
        return {"supported": True, "reason": f"(verifier error, defaulting to pass: {e})"}


def query_rewriter_node(state: AgentState) -> dict:
    """Refine the retrieval query based on what the critic flagged as missing."""
    failed = state.get("failed_claims") or []
    if not failed:
        return {"query": state.get("query") or state["question"]}

    failed_block = "\n".join(f"- {f['claim']} ({f['reason']})" for f in failed)
    prompt = (
        "You rewrite a retrieval query to better surface evidence for unverified claims.\n"
        "Return ONLY a JSON object with one key 'query' (a single short search query string).\n\n"
        f"Original question: {state['question']}\n"
        f"Previous query: {state.get('query', '')}\n"
        f"Unverified claims (need better evidence):\n{failed_block}\n\n"
        "JSON:"
    )
    try:
        raw = _strip_fences(ask_gemini(prompt))
        new_q = json.loads(raw).get("query") or state["question"]
    except Exception:
        new_q = state["question"]
    return {"query": new_q}


def critic_decides(state: AgentState) -> str:
    if state.get("verified"):
        return END
    if state.get("retry_count", 0) >= MAX_RETRIES:
        return END
    return "rewriter"


# ----------------------------- graph -----------------------------

def build_graph():
    g = StateGraph(AgentState)
    g.add_node("router", router_node)
    g.add_node("retriever", retriever_node)
    g.add_node("generator", generator_node)
    g.add_node("critic", critic_node)
    g.add_node("rewriter", query_rewriter_node)

    g.add_edge(START, "router")
    g.add_conditional_edges("router", fan_out_to_retrievers, ["retriever"])
    g.add_edge("retriever", "generator")
    g.add_edge("generator", "critic")
    g.add_conditional_edges("critic", critic_decides, [END, "rewriter"])
    g.add_conditional_edges("rewriter", fan_out_to_retrievers, ["retriever"])

    return g.compile()


_compiled = build_graph()


def answer_question(question: str) -> dict:
    """Run the full graph synchronously (kept for callers that don't stream)."""
    final = _compiled.invoke({"question": question, "query": question, "retry_count": 0})
    return {
        "answer": final.get("answer", ""),
        "consulted": final.get("consulted", []),
        "chunks": final.get("chunks", []),
        "routed_doc_ids": final.get("doc_ids", []),
        "citations": final.get("citations", []),
        "verified": final.get("verified", False),
        "retry_count": final.get("retry_count", 0),
    }


def stream_answer(question: str):
    """Yield events as the graph executes, for SSE streaming."""
    initial = {"question": question, "query": question, "retry_count": 0}
    # stream_mode='updates' gives {node_name: partial_state} per step
    for update in _compiled.stream(initial, stream_mode="updates"):
        for node, partial in update.items():
            event: dict = {"node": node}
            if node == "router":
                event["doc_ids"] = partial.get("doc_ids", [])
                event["query"] = partial.get("query")
            elif node == "retriever":
                event["chunks_added"] = len(partial.get("chunks", []))
            elif node == "generator":
                event["answer"] = partial.get("answer", "")
                event["consulted"] = partial.get("consulted", [])
            elif node == "critic":
                event["verified"] = partial.get("verified", False)
                event["citations"] = partial.get("citations", [])
                event["failed_claims"] = partial.get("failed_claims", [])
                event["retry_count"] = partial.get("retry_count", 0)
            elif node == "rewriter":
                event["query"] = partial.get("query")
            yield event
    yield {"node": "done"}
