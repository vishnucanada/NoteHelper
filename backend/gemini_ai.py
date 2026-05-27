import json
import os

from dotenv import load_dotenv
from google import genai

load_dotenv()

_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
_MODEL = "gemini-2.5-flash"


def ask_gemini(prompt: str, model: str | None = None) -> str:
    response = _client.models.generate_content(
        model=model or _MODEL,
        contents=prompt,
    )
    return response.text or ""


def summarize_this(original_text: str) -> str:
    try:
        return ask_gemini(
            "Summarize this document and return ONLY valid JSON (no markdown, no code fences). "
            "JSON structure must have these exact keys: one_sentence_explanation, brief_summary, key_take_aways. "
            "one_sentence_explanation: one concise sentence, "
            "brief_summary: 2-3 paragraph summary, "
            "key_take_aways: bullet points of main points. "
            f"Document text: {original_text[:10000]}"
        )
    except Exception as e:
        return json.dumps({
            "error": f"AI service error: {str(e)}",
            "one_sentence_explanation": "Failed to generate summary",
            "brief_summary": "There was an error processing your document",
            "key_take_aways": "Please try again or check your API key",
        })


if __name__ == "__main__":
    print("Using Main...")
