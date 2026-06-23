// Backendless runtime config. NoteHelper now runs entirely in the browser and
// calls the Gemini API directly with the user's own key (managed in lib/apikey.js).
// There is no backend server to point at anymore.

// Point pdf.js at its worker (must match the version loaded in index.html).
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// arXiv's API sends no CORS headers, so the external-tools branch uses Wikipedia
// only by default. Flip this to true if you proxy arXiv through a CORS-enabled host.
if (window.NH && window.NH.config) {
    window.NH.config.ENABLE_ARXIV = false;
}
