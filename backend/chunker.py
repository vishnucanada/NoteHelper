import io
import uuid
import PyPDF2
from langchain_text_splitters import RecursiveCharacterTextSplitter


_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
    separators=["\n\n", "\n", ". ", " ", ""],
)


def new_doc_id() -> str:
    return uuid.uuid4().hex[:12]


def extract_pages(file_bytes: bytes) -> list[str]:
    reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
    return [(page.extract_text() or "") for page in reader.pages]


def chunk_pdf(file_bytes: bytes, doc_id: str, filename: str) -> tuple[list[dict], str]:
    """Return (chunks, full_text). Each chunk: {doc_id, filename, page, chunk_idx, text}."""
    pages = extract_pages(file_bytes)
    chunks: list[dict] = []
    idx = 0
    for page_num, page_text in enumerate(pages, start=1):
        if not page_text.strip():
            continue
        for piece in _splitter.split_text(page_text):
            chunks.append({
                "doc_id": doc_id,
                "filename": filename,
                "page": page_num,
                "chunk_idx": idx,
                "text": piece,
            })
            idx += 1
    full_text = "\n".join(pages)
    return chunks, full_text
