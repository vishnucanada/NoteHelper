"""External knowledge tools for the ReAct fallback branch.

When the critic can't verify an answer against the internal library after its
retry budget is spent, the agent reaches outside: it reasons about which tool
fits the gap, fetches evidence, and returns it as chunks in the same shape the
generator/critic already understand (so the rest of the graph is unchanged).

No API keys required — Wikipedia and arXiv both expose open HTTP endpoints.
"""
import json
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from gemini_ai import ask_gemini

_USER_AGENT = "NoteHelper/1.0 (study assistant; +https://github.com/vishnucanada/note-helper)"
_TIMEOUT = 12


def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return resp.read()


def _strip_fences(text: str) -> str:
    import re
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()


# ----------------------------- tool: Wikipedia -----------------------------

def wikipedia_search(query: str, limit: int = 3) -> list[dict]:
    """Return external chunks from the top Wikipedia matches for a query."""
    search_url = (
        "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json"
        f"&srlimit={limit}&srsearch={urllib.parse.quote(query)}"
    )
    try:
        data = json.loads(_http_get(search_url))
    except Exception:
        return []

    chunks: list[dict] = []
    for i, hit in enumerate(data.get("query", {}).get("search", [])[:limit]):
        title = hit.get("title", "")
        if not title:
            continue
        summary_url = (
            "https://en.wikipedia.org/api/rest_v1/page/summary/"
            + urllib.parse.quote(title.replace(" ", "_"))
        )
        try:
            summary = json.loads(_http_get(summary_url))
        except Exception:
            continue
        extract = (summary.get("extract") or "").strip()
        if not extract:
            continue
        page_url = (summary.get("content_urls", {}).get("desktop", {}) or {}).get("page", "")
        chunks.append(_external_chunk(
            source="wikipedia",
            idx=i,
            title=title,
            text=extract,
            url=page_url or f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title)}",
        ))
    return chunks


# ----------------------------- tool: arXiv -----------------------------

_ARXIV_NS = {"atom": "http://www.w3.org/2005/Atom"}


def arxiv_search(query: str, limit: int = 3) -> list[dict]:
    """Return external chunks from the top arXiv abstracts for a query."""
    url = (
        "http://export.arxiv.org/api/query?"
        f"search_query=all:{urllib.parse.quote(query)}&start=0&max_results={limit}"
    )
    try:
        root = ET.fromstring(_http_get(url))
    except Exception:
        return []

    chunks: list[dict] = []
    for i, entry in enumerate(root.findall("atom:entry", _ARXIV_NS)[:limit]):
        title = (entry.findtext("atom:title", default="", namespaces=_ARXIV_NS) or "").strip()
        summary = (entry.findtext("atom:summary", default="", namespaces=_ARXIV_NS) or "").strip()
        link = (entry.findtext("atom:id", default="", namespaces=_ARXIV_NS) or "").strip()
        if not title or not summary:
            continue
        chunks.append(_external_chunk(
            source="arxiv",
            idx=i,
            title=title,
            text=f"{title}. {summary}",
            url=link,
        ))
    return chunks


_TOOLS = {
    "wikipedia": wikipedia_search,
    "arxiv": arxiv_search,
}


# ----------------------------- tool selection (ReAct) -----------------------------

def select_tool(question: str, failed_claims: list[dict]) -> dict:
    """Ask Gemini which external tool to use and what to search for.

    Returns {tool, query, reason}. Falls back to a Wikipedia search on the
    original question if the model can't decide.
    """
    fallback = {"tool": "wikipedia", "query": question, "reason": "default external lookup"}
    failed_block = "\n".join(f"- {f.get('claim', '')} ({f.get('reason', '')})" for f in failed_claims) or "(none)"
    prompt = (
        "You are a research agent deciding how to fill a knowledge gap.\n"
        "The internal document library could not verify an answer. Pick ONE external tool:\n"
        "  - 'wikipedia': general/background knowledge, definitions, well-established facts.\n"
        "  - 'arxiv': cutting-edge research, technical/scientific papers, recent methods.\n"
        "Return ONLY valid JSON with keys 'tool' ('wikipedia' or 'arxiv'), "
        "'query' (a short search string), and 'reason' (one short clause).\n\n"
        f"Question: {question}\n"
        f"Claims we failed to verify internally:\n{failed_block}\n\n"
        "JSON:"
    )
    try:
        parsed = json.loads(_strip_fences(ask_gemini(prompt)))
        tool = parsed.get("tool")
        if tool not in _TOOLS:
            tool = "wikipedia"
        return {
            "tool": tool,
            "query": (parsed.get("query") or question).strip(),
            "reason": str(parsed.get("reason", ""))[:200],
        }
    except Exception:
        return fallback


def run_tool(tool: str, query: str, limit: int = 3) -> list[dict]:
    fn = _TOOLS.get(tool, wikipedia_search)
    return fn(query, limit=limit)


# ----------------------------- helpers -----------------------------

def _external_chunk(source: str, idx: int, title: str, text: str, url: str) -> dict:
    """Shape an external result like an internal chunk so the rest of the graph
    (generator context, critic verification, citations) treats it uniformly."""
    label = {"wikipedia": "Wikipedia", "arxiv": "arXiv"}.get(source, source)
    return {
        "id": f"ext_{source}_{idx}",
        "text": text[:1500],
        "doc_id": f"external:{source}",
        "filename": f"{label}: {title}",
        "page": "web",
        "chunk_idx": idx,
        "source": "external",
        "url": url,
    }
