FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt .
RUN pip install -r requirements.txt

# App code. Imports in endpoint.py are flat (e.g. `from chunker import ...`),
# so gunicorn must run from inside the backend/ dir.
COPY backend/ ./backend/

WORKDIR /app/backend

EXPOSE 8080

# Threaded workers so SSE streaming (text/event-stream) isn't blocked; long
# timeout because LLM answers stream for a while. ChromaDB writes to the
# CHROMA_PERSIST_DIR volume, so keep a single worker to avoid concurrent writers.
CMD ["gunicorn", "endpoint:app", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "1", \
     "--threads", "8", \
     "--worker-class", "gthread", \
     "--timeout", "300"]
