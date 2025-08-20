document.addEventListener('DOMContentLoaded', function() {
    // Elements
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileDetails = document.getElementById('fileDetails');
    const progressBar = document.getElementById('progressBar');
    const summarizeBtn = document.getElementById('summarizeBtn');
    const resetBtn = document.getElementById('resetBtn');
    const summaryArea = document.getElementById('summaryArea');
    const summaryContent = document.getElementById('summaryContent');
    const buttonText = document.getElementById('buttonText');

    // Follow-up section
    const followupArea = document.getElementById('followupArea');
    const questionInput = document.getElementById('questionInput');
    const askBtn = document.getElementById('askBtn');
    const qaResponse = document.getElementById('qaResponse');

    let currentFile = null;
    
    // Event listeners
    uploadArea.addEventListener('click', () => fileInput.click());
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('active');
    });
    
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('active');
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('active');
        
        if (e.dataTransfer.files.length) {
            fileInput.files = e.dataTransfer.files;
            handleFileSelection(e.dataTransfer.files[0]);
        }
    });
    
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) {
            handleFileSelection(fileInput.files[0]);
        }
    });
    
    summarizeBtn.addEventListener('click', generateSummary);
    resetBtn.addEventListener('click', resetAll);
    askBtn.addEventListener('click', askQuestion);  // follow-up only after summary is ready
    
    // Functions
    function handleFileSelection(file) {
        if (file.type !== 'application/pdf') {
            alert('Please select a PDF file.');
            return;
        }
        
        currentFile = file;
        
        // Display file information
        fileInfo.classList.remove('hidden');
        fileDetails.innerHTML = `
            <div class="file-detail">
                <span class="file-label">Name:</span>
                <span class="file-value">${file.name}</span>
            </div>
            <div class="file-detail">
                <span class="file-label">Type:</span>
                <span class="file-value">${file.type || 'PDF Document'}</span>
            </div>
            <div class="file-detail">
                <span class="file-label">Size:</span>
                <span class="file-value">${formatFileSize(file.size)}</span>
            </div>
            <div class="file-detail">
                <span class="file-label">Last Modified:</span>
                <span class="file-value">${new Date(file.lastModified).toLocaleDateString()}</span>
            </div>
        `;
        
        // Enable summarize button
        summarizeBtn.disabled = false;
        
        // Hide any previous summary + follow-up
        summaryArea.classList.add('hidden');
        followupArea.classList.add('hidden');
    }
    
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i]);
    }
    async function generateSummary() {
        if (!currentFile) return;
        
        // Show loading state
        buttonText.textContent = 'Processing...';
        summarizeBtn.disabled = true;
        
        try {
            const formData = new FormData();
            formData.append('file', currentFile);
            
            const response = await fetch('http://127.0.0.1:5000/message', {
                method: 'POST',
                body: formData
            });
            
            const result = await response.json();
            
            if (!response.ok) {
                throw new Error(result.error || `Server error: ${response.status}`);
            }
            
            const data = result.data.text;
            console.log('Summary data:', data);
            
            // Display the summary
            summaryArea.classList.remove('hidden');
            summaryContent.innerHTML = `
                <h3>Explanation of "${currentFile.name}"</h3>
                <p><strong>One Sentence Explanation: </strong> ${data.one_sentence_explanation}</p>
                <p><strong>Brief Summary: </strong> ${data.brief_summary}</p>
                <h4>Key Takeaways: </h4>
                <p>${data.key_take_aways}</p>
            `;
    
            // Unlock follow-up section
            followupArea.classList.remove('hidden');
            
        } catch (error) {
            console.error('Error generating summary:', error);
            alert(`Failed to generate summary: ${error.message}`);
        } finally {
            buttonText.textContent = 'Analyze Document';
            summarizeBtn.disabled = false;
        }
    }
    async function askQuestion() {
        const question = questionInput.value.trim();
        if (!question) {
            alert('Please enter a question.');
            return;
        }
        askBtn.textContent = "Generating..."
        
        try {
            const response = await fetch('http://127.0.0.1:5000/followup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question })
            });
    
            const result = await response.json();
            
            if (!response.ok) {
                throw new Error(result.error || `Server error: ${response.status}`);
            }
    
            const data = result.data;
            console.log('Answer data:', data);
            
            // Show Q&A thread
            const answerEl = document.createElement('div');
            answerEl.className = 'qa-item';
            answerEl.innerHTML = `
                <p><strong>Question: </strong> ${question}</p>
                <p><strong>Answer: </strong> ${data.answer}</p>
                <hr>
            `;
            qaResponse.prepend(answerEl); // Add to top
            questionInput.value = '';
            
        } catch (error) {
            console.error('Error asking question:', error);
            alert(`Failed to get response: ${error.message}`);
        } finally {
            askBtn.textContent = "Ask";
        }
    }
    
    function resetAll() {
        fileInput.value = '';
        currentFile = null;
        
        fileInfo.classList.add('hidden');
        summaryArea.classList.add('hidden');
        followupArea.classList.add('hidden');
        
        progressBar.style.width = '0%';
        summarizeBtn.disabled = true;
    }
});
