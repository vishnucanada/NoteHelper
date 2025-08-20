from flask import Flask, jsonify, request
from flask_cors import CORS
import PyPDF2
import io
import json
from gemini_ai import summarize_this, ask_prompt
import re

app = Flask(__name__)
# Enable CORS for all routes with specific origins
CORS(app, origins=["http://127.0.0.1:5500", "http://localhost:5500"])

# Simple in-memory storage for demonstration
messages = []

def clean_json(text):
    text = re.sub(r'^```json\s*|\s*```$', '', text, flags=re.MULTILINE)
    text = text.strip()
    return text
@app.route('/message', methods=['GET', 'POST', 'OPTIONS'])
def handle_message():
    if request.method == 'OPTIONS':
        # Handle preflight requests
        response = jsonify({'status': 'ok'})
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        response.headers.add('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        return response
    
    if request.method == 'GET':
        # GET - Retrieve all messages
        response = jsonify({
            'messages': messages,
            'count': len(messages)
        })
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        return response
    
    elif request.method == 'POST':
        # Check if a file was uploaded
        if 'file' not in request.files:
            response = jsonify({'error': 'No file uploaded'})
            response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
            return response, 400
        
        file = request.files['file']
        
        # Check if the file is a PDF
        if file.filename == '' or not file.filename.lower().endswith('.pdf'):
            response = jsonify({'error': 'Invalid file type. Please upload a PDF'})
            response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
            return response, 400
        
        try:
            # Read and process the PDF
            pdf_reader = PyPDF2.PdfReader(io.BytesIO(file.read()))
            text = ""
            
            # Extract text from each page
            for page in pdf_reader.pages:
                text += page.extract_text() + "\n"
            
            # For demonstration, just return the first 500 characters
            #summary_text = text[:500] + "..." if len(text) > 500 else text
            ai_response = summarize_this(text)
            ai_response_json = clean_json(ai_response)
            print(ai_response_json)
            ai_response_json = json.loads(ai_response_json)
            # Create a response message
            new_message = {
                'id': len(messages) + 1,
                'text': ai_response_json,
                'filename': file.filename
            }
            
            messages.append(new_message)
            response = jsonify({'message': 'PDF processed successfully', 'data': new_message})
            response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
            return response, 201
            
        except Exception as e:
            response = jsonify({'error': f'Failed to process PDF: {str(e)}'})
            response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
            return response, 500
@app.route('/followup', methods=['POST', 'OPTIONS'])
def followup():
    if request.method == 'OPTIONS':
        # Preflight response
        response = jsonify({'status': 'ok'})
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type')
        response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS')
        return response

    data = request.get_json()
    question = data.get("question", "")

    if not question:
        response = jsonify({'error': 'No question provided'})
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        return response, 400

    try:
        # Get AI answer
        ai_answer = ask_prompt(question)
        print("Raw AI Answer:", ai_answer)
        
        # Clean and parse JSON
        cleaned_answer = clean_json(ai_answer)
        try:
            ai_answer_json = json.loads(cleaned_answer)
        except json.JSONDecodeError as e:
            return jsonify({
                'error': 'Failed to parse AI response as JSON',
                'raw_response': ai_answer
            }), 500
        
        # Return consistent response structure
        response = jsonify({
            'message': 'Question answered successfully',
            'data': ai_answer_json
        })
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        return response, 200
        
    except Exception as e:
        response = jsonify({'error': f'Failed to process question: {str(e)}'})
        response.headers.add('Access-Control-Allow-Origin', 'http://127.0.0.1:5500')
        return response, 500
    
if __name__ == '__main__':
    app.run(debug=True, port=5000)