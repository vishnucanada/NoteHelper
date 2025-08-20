from google import genai
from dotenv import load_dotenv
import os
import json

load_dotenv()

api_key = os.getenv('GEMINI_API_KEY')
client = genai.Client(api_key=api_key)

document = ""

def summarize_this(original_text):
    global document
    document = original_text

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=(
                f"Summarize this document and return ONLY valid JSON (no markdown, no code fences). "
                f"JSON structure must have these exact keys: one_sentence_explanation, brief_summary, key_take_aways. "
                f"one_sentence_explanation: one concise sentence, "
                f"brief_summary: 2-3 paragraph summary, "
                f"key_take_aways: bullet points of main points. "
                f"Document text: {document[:10000]}"  # Limit length to avoid token issues
            )
        )
        return response.text
    except Exception as e:
        return json.dumps({
            "error": f"AI service error: {str(e)}",
            "one_sentence_explanation": "Failed to generate summary",
            "brief_summary": "There was an error processing your document",
            "key_take_aways": "Please try again or check your API key"
        })

def ask_prompt(prompt):
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=(
                f"Answer this question based on the provided document. "
                f"Return ONLY valid JSON with a single key 'answer'. "
                f"No markdown, no code fences. "
                f"Document: {document[:5000]}... "
                f"Question: {prompt}"
            )
        )
        return response.text
    except Exception as e:
        return json.dumps({
            "error": f"AI service error: {str(e)}",
            "answer": "Failed to generate answer. Please try again."
        })
if __name__ == '__main__':
    print('Using Main...')
