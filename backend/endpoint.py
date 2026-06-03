import json
import re

from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

from chunker import chunk_pdf, new_doc_id
from gemini_ai import summarize_this
from graph import answer_question, stream_answer
from vectorstore import (
    add_document,
    delete_document,
    get_document,
    list_documents,
)

app = Flask(__name__)
CORS(app, origins=[
    "http://127.0.0.1:5500",
    "http://localhost:5500",
    "http://127.0.0.1:5000",
    "http://localhost:5000",
])


def _clean_json(text: str) -> str:
    return re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()


@app.route("/message", methods=["POST"])
def upload_document():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "" or not file.filename.lower().endswith(".pdf"):
        return jsonify({"error": "Invalid file type. Please upload a PDF"}), 400

    try:
        file_bytes = file.read()
        doc_id = new_doc_id()
        chunks, full_text = chunk_pdf(file_bytes, doc_id, file.filename)

        if not chunks:
            return jsonify({"error": "Could not extract text from PDF"}), 400

        summary_raw = summarize_this(full_text)
        try:
            summary = json.loads(_clean_json(summary_raw))
        except json.JSONDecodeError:
            summary = {
                "one_sentence_explanation": "(summary unavailable)",
                "brief_summary": summary_raw[:500],
                "key_take_aways": "",
            }

        add_document(doc_id, file.filename, summary, chunks)

        return jsonify({
            "message": "PDF processed successfully",
            "data": {
                "doc_id": doc_id,
                "filename": file.filename,
                "num_chunks": len(chunks),
                "text": summary,
            },
        }), 201
    except Exception as e:
        return jsonify({"error": f"Failed to process PDF: {str(e)}"}), 500


@app.route("/documents", methods=["GET"])
def get_documents():
    return jsonify({"documents": list_documents()})


@app.route("/documents/<doc_id>", methods=["DELETE"])
def remove_document(doc_id: str):
    if not get_document(doc_id):
        return jsonify({"error": "Document not found"}), 404
    delete_document(doc_id)
    return jsonify({"message": "Deleted", "doc_id": doc_id})


@app.route("/followup", methods=["POST"])
def followup():
    """SSE stream of graph events. Each event = one node completion."""
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "No question provided"}), 400

    @stream_with_context
    def generate():
        try:
            for event in stream_answer(question):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'node': 'error', 'message': str(e)})}\n\n"

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/followup/sync", methods=["POST"])
def followup_sync():
    """Non-streaming fallback. Same payload as before."""
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    if not question:
        return jsonify({"error": "No question provided"}), 400
    try:
        result = answer_question(question)
        return jsonify({"message": "Question answered successfully", "data": result})
    except Exception as e:
        return jsonify({"error": f"Failed to process question: {str(e)}"}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
