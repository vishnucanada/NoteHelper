// Gemini API key management. In the backendless model the user brings their own
// key; it lives only in this browser's localStorage. A first-run modal collects
// it, and a settings gear lets them update it later.
(function () {
    const NH = (window.NH = window.NH || {});
    const STORAGE_KEY = 'nh_gemini_api_key';

    function get() {
        return localStorage.getItem(STORAGE_KEY) || '';
    }

    function set(key) {
        const trimmed = (key || '').trim();
        if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
        else localStorage.removeItem(STORAGE_KEY);
    }

    function has() {
        return !!get();
    }

    // Thrown by gemini.js when no key is set, so callers can prompt instead of
    // surfacing a raw network error.
    class MissingKeyError extends Error {
        constructor() {
            super('No Gemini API key set. Add one in Settings to use NoteHelper.');
            this.name = 'MissingKeyError';
        }
    }

    function require_() {
        const k = get();
        if (!k) throw new MissingKeyError();
        return k;
    }

    // ---- modal ----
    function ensureModal() {
        let modal = document.getElementById('nh-key-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'nh-key-modal';
        modal.className = 'nh-modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="nh-modal" role="dialog" aria-modal="true" aria-labelledby="nh-key-title">
                <h2 id="nh-key-title">🔑 Gemini API key</h2>
                <p>NoteHelper runs entirely in your browser and calls Google Gemini
                   directly with <strong>your own key</strong>. It's stored only on this
                   device (localStorage) and never sent anywhere else.</p>
                <p class="nh-modal-hint">Get a free key at
                   <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>.
                   Tip: restrict it to your site's domain in the Google console.</p>
                <input id="nh-key-input" type="password" placeholder="AIza..." autocomplete="off" spellcheck="false" />
                <div class="nh-modal-actions">
                    <button id="nh-key-cancel" class="nh-btn-secondary" type="button">Cancel</button>
                    <button id="nh-key-save" class="nh-btn-primary" type="button">Save</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        const input = modal.querySelector('#nh-key-input');
        const save = modal.querySelector('#nh-key-save');
        const cancel = modal.querySelector('#nh-key-cancel');

        function close() { modal.hidden = true; }
        save.addEventListener('click', () => {
            set(input.value);
            close();
            if (typeof modal._onSave === 'function') modal._onSave(get());
        });
        cancel.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
        return modal;
    }

    // Open the modal. onSave(key) fires after a successful save.
    function openModal(onSave) {
        const modal = ensureModal();
        modal._onSave = onSave;
        const input = modal.querySelector('#nh-key-input');
        input.value = get();
        modal.hidden = false;
        setTimeout(() => input.focus(), 50);
    }

    // Prompt on first load if no key is present.
    function promptIfMissing(onSave) {
        if (!has()) openModal(onSave);
    }

    NH.apikey = { get, set, has, require: require_, openModal, promptIfMissing, MissingKeyError };
})();
