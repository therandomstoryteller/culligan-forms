/**
 * OWL Forms SDK v1.0
 * 
 * JavaScript library for external forms to communicate with
 * the OWL Forms Platform in Salesforce.
 * 
 * Usage:
 *   <script src="owl-sdk.js"></script>
 *   <script>
 *     OwlForms.init({
 *       baseUrl: 'https://your-site.salesforce-sites.com',
 *       token: new URLSearchParams(window.location.search).get('token')
 *     });
 *   </script>
 */
(function(global) {
    'use strict';

    const VERSION = '1.0.0';

    let _config = {
        baseUrl: '',
        token: '',
        autoSaveDraft: false,
        autoSaveInterval: 30000,
        onLoad: null,
        onSubmitSuccess: null,
        onSubmitError: null,
        onDraftSaved: null,
        onError: null,
        debug: false
    };

    let _formData = {};
    let _prefillData = {};
    let _formConfig = {};
    let _linkId = null;
    let _allowDraft = false;
    let _initialized = false;
    let _autoSaveTimer = null;
    let _submitting = false;

    function log(...args) {
        if (_config.debug) {
            console.log('[OWL SDK]', ...args);
        }
    }

    function error(...args) {
        console.error('[OWL SDK]', ...args);
    }

    async function apiCall(endpoint, method, body) {
        const url = method === 'GET'
            ? `${_config.baseUrl}/services/apexrest/owl/${endpoint}`
            : `${_config.baseUrl}/services/apexrest/owl/${endpoint}`;

        const options = {
            method: method,
            headers: { 'Content-Type': 'application/json' }
        };

        if (body) {
            options.body = JSON.stringify(body);
        }

        log(`${method} ${url}`);

        try {
            const response = await fetch(url, options);
            const data = await response.json();
            log('Response:', response.status, data);
            return { status: response.status, data: data };
        } catch (err) {
            error('API call failed:', err);
            throw new OwlError('Network error: Unable to reach Salesforce.', 'NETWORK_ERROR');
        }
    }

    class OwlError extends Error {
        constructor(message, code) {
            super(message);
            this.name = 'OwlError';
            this.code = code;
        }
    }

    // --- Core SDK Methods ---

    async function init(options) {
        if (!options.baseUrl) throw new OwlError('baseUrl is required', 'CONFIG_ERROR');
        if (!options.token) throw new OwlError('token is required', 'CONFIG_ERROR');

        Object.assign(_config, options);

        _config.baseUrl = _config.baseUrl.replace(/\/+$/, '');

        log('Initializing with token:', _config.token.substring(0, 8) + '...');

        try {
            showLoading(true);

            const result = await apiCall(
                `form-config?token=${encodeURIComponent(_config.token)}`,
                'GET'
            );

            if (!result.data.success) {
                const err = new OwlError(result.data.error || 'Failed to load form config', 'LOAD_ERROR');
                if (_config.onError) _config.onError(err);
                showLoading(false);
                showError(result.data.error || 'This form link is invalid or has expired.');
                return false;
            }

            _formConfig = result.data.config || {};
            _prefillData = result.data.data || {};
            _linkId = result.data.linkId;
            _allowDraft = result.data.allowDraft || false;
            _initialized = true;

            applyPrefill(_prefillData);
            applyConditions(_formConfig);

            if (_config.autoSaveDraft && _allowDraft) {
                startAutoSave();
            }

            showLoading(false);

            if (_config.onLoad) {
                _config.onLoad({
                    config: _formConfig,
                    data: _prefillData,
                    linkId: _linkId
                });
            }

            log('Initialization complete');
            return true;

        } catch (err) {
            showLoading(false);
            if (_config.onError) _config.onError(err);
            showError('Unable to load form. Please try again later.');
            return false;
        }
    }

    function applyPrefill(data) {
        if (!data || typeof data !== 'object') return;

        log('Applying prefill data:', Object.keys(data).length, 'fields');

        for (const [key, value] of Object.entries(data)) {
            if (key.startsWith('_')) continue;

            const elements = findFieldElements(key);
            elements.forEach(el => {
                setFieldValue(el, value);
            });
        }
    }

    function findFieldElements(fieldKey) {
        const selectors = [
            `[data-owl-field="${fieldKey}"]`,
            `[data-owl="${fieldKey}"]`,
            `[name="${fieldKey}"]`,
            `#${fieldKey}`
        ];

        for (const selector of selectors) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) return Array.from(elements);
            } catch (e) {
                // Invalid selector, skip
            }
        }
        return [];
    }

    function setFieldValue(element, value) {
        if (!element || value === null || value === undefined) return;

        const tagName = element.tagName.toLowerCase();
        const type = (element.type || '').toLowerCase();

        if (tagName === 'input') {
            if (type === 'checkbox') {
                element.checked = Boolean(value);
            } else if (type === 'radio') {
                element.checked = (element.value === String(value));
            } else if (type === 'file') {
                // Cannot set file inputs programmatically
            } else {
                element.value = value;
            }
        } else if (tagName === 'select') {
            element.value = value;
        } else if (tagName === 'textarea') {
            element.value = value;
        } else {
            // For non-input elements (spans, divs, paragraphs), set text content
            element.textContent = value;
        }

        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function applyConditions(config) {
        if (!config || !config.conditions) return;

        log('Applying conditions:', Object.keys(config.conditions).length);

        for (const [conditionKey, result] of Object.entries(config.conditions)) {
            const elements = document.querySelectorAll(`[data-owl-condition="${conditionKey}"]`);
            elements.forEach(el => {
                if (result) {
                    el.style.display = '';
                    el.removeAttribute('data-owl-hidden');
                } else {
                    el.style.display = 'none';
                    el.setAttribute('data-owl-hidden', 'true');
                }
            });
        }
    }

    // --- Collection Handling ---

    function applyCollections(config, data) {
        if (!config || !config.collections) return;

        for (const collection of config.collections) {
            const container = document.querySelector(`[data-owl-collection="${collection.key}"]`);
            if (!container) continue;

            const template = container.querySelector('[data-owl-template]');
            if (!template) continue;

            const items = data[`_collection_${collection.key}`] || [];
            template.style.display = 'none';

            items.forEach((item, index) => {
                const row = template.cloneNode(true);
                row.style.display = '';
                row.removeAttribute('data-owl-template');
                row.setAttribute('data-owl-index', index);

                for (const [key, value] of Object.entries(item)) {
                    const field = row.querySelector(`[data-owl-field="${key}"]`);
                    if (field) setFieldValue(field, value);
                }

                container.appendChild(row);
            });
        }
    }

    // --- PDF Capture ---

    let _pdfLibLoaded = false;

    async function loadPdfLibrary() {
        if (_pdfLibLoaded) return true;
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js';
            script.onload = () => { _pdfLibLoaded = true; resolve(true); };
            script.onerror = () => { error('Failed to load html2pdf.js'); resolve(false); };
            document.head.appendChild(script);
        });
    }

    async function captureFormPdf() {
        log('Capturing form as PDF...');
        const loaded = await loadPdfLibrary();
        if (!loaded) return null;

        const pages = document.querySelectorAll('[data-owl-page]');

        if (pages.length > 1) {
            return await captureMultiPagePdf(pages);
        }

        const container = document.getElementById('owl-form-container') || document.body;
        const opt = {
            margin: 10,
            filename: 'form-submission.pdf',
            image: { type: 'jpeg', quality: 0.85 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
        };

        try {
            const pdfBlob = await html2pdf().set(opt).from(container).outputPdf('blob');
            return await blobToBase64(pdfBlob);
        } catch (err) {
            error('PDF capture failed:', err);
            return null;
        }
    }

    async function captureMultiPagePdf(pages) {
        const opt = {
            margin: 10,
            image: { type: 'jpeg', quality: 0.85 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };

        const originalDisplay = [];
        pages.forEach((page, i) => {
            originalDisplay[i] = page.style.display;
        });

        pages.forEach(page => { page.style.display = 'block'; });

        const wrapper = document.createElement('div');
        pages.forEach(page => {
            const clone = page.cloneNode(true);
            clone.style.display = 'block';
            clone.style.pageBreakAfter = 'always';
            wrapper.appendChild(clone);
        });

        document.body.appendChild(wrapper);

        try {
            const pdfBlob = await html2pdf().set(opt).from(wrapper).outputPdf('blob');
            return await blobToBase64(pdfBlob);
        } catch (err) {
            error('Multi-page PDF capture failed:', err);
            return null;
        } finally {
            wrapper.remove();
            pages.forEach((page, i) => { page.style.display = originalDisplay[i]; });
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.readAsDataURL(blob);
        });
    }

    // --- Form Submission ---

    async function submit(options = {}) {
        if (!_initialized) {
            throw new OwlError('SDK not initialized. Call OwlForms.init() first.', 'NOT_INITIALIZED');
        }

        if (_submitting) {
            log('Submission already in progress, ignoring');
            return;
        }

        _submitting = true;
        stopAutoSave();

        try {
            const formData = collectFormData();
            const mergedData = { ..._formData, ...formData };

            log('Submitting form data:', Object.keys(mergedData).length, 'fields');

            if (options.showLoading !== false) {
                showSubmitting(true);
            }

            if (_formConfig.generatePdf) {
                log('PDF capture enabled, generating...');
                const pdfBase64 = await captureFormPdf();
                if (pdfBase64) {
                    mergedData._pdf = pdfBase64;
                    log('PDF captured, size:', Math.round(pdfBase64.length / 1024) + 'KB');
                }
            }

            const result = await apiCall('submission', 'POST', {
                token: _config.token,
                data: mergedData,
                isDraft: false
            });

            showSubmitting(false);

            if (result.data.success) {
                log('Submission successful:', result.data.submissionId);

                if (_config.onSubmitSuccess) {
                    _config.onSubmitSuccess(result.data);
                }

                if (result.data.redirectUrl) {
                    setTimeout(() => {
                        window.location.href = result.data.redirectUrl;
                    }, 1500);
                } else {
                    showSuccess(result.data.message || 'Form submitted successfully.');
                }

                return result.data;
            } else {
                const err = new OwlError(result.data.error || 'Submission failed', 'SUBMISSION_ERROR');
                if (_config.onSubmitError) _config.onSubmitError(err, result.data);
                showFormError(result.data.error || 'Submission failed. Please try again.');
                return result.data;
            }

        } catch (err) {
            showSubmitting(false);
            if (_config.onSubmitError) _config.onSubmitError(err);
            showFormError('Unable to submit. Please check your connection and try again.');
            throw err;
        } finally {
            _submitting = false;
        }
    }

    // --- Draft Save ---

    async function saveDraft() {
        if (!_initialized || !_allowDraft) return;

        try {
            const formData = collectFormData();
            const mergedData = { ..._formData, ...formData };

            log('Saving draft...');

            const result = await apiCall('submission', 'POST', {
                token: _config.token,
                data: mergedData,
                isDraft: true
            });

            if (result.data.success) {
                log('Draft saved:', result.data.submissionId);
                if (_config.onDraftSaved) _config.onDraftSaved(result.data);
                showDraftIndicator();
            }

            return result.data;
        } catch (err) {
            log('Draft save failed (silent):', err.message);
        }
    }

    function startAutoSave() {
        if (_autoSaveTimer) return;
        _autoSaveTimer = setInterval(() => {
            saveDraft();
        }, _config.autoSaveInterval);
        log('Auto-save started, interval:', _config.autoSaveInterval + 'ms');
    }

    function stopAutoSave() {
        if (_autoSaveTimer) {
            clearInterval(_autoSaveTimer);
            _autoSaveTimer = null;
            log('Auto-save stopped');
        }
    }

    // --- Data Collection ---

    function collectFormData() {
        const data = {};

        // Collect from data-owl-field elements
        document.querySelectorAll('[data-owl-field]').forEach(el => {
            const key = el.getAttribute('data-owl-field');
            if (el.closest('[data-owl-hidden="true"]')) return;
            if (el.closest('[data-owl-template]')) return;
            data[key] = getFieldValue(el);
        });

        // Collect from data-owl elements
        document.querySelectorAll('[data-owl]').forEach(el => {
            const key = el.getAttribute('data-owl');
            if (el.closest('[data-owl-hidden="true"]')) return;
            if (el.closest('[data-owl-template]')) return;
            if (!data[key]) data[key] = getFieldValue(el);
        });

        // Collect from named form fields
        document.querySelectorAll('input[name], select[name], textarea[name]').forEach(el => {
            const key = el.getAttribute('name');
            if (key.startsWith('_owl_')) return;
            if (el.closest('[data-owl-hidden="true"]')) return;
            if (el.closest('[data-owl-template]')) return;
            if (!data[key]) data[key] = getFieldValue(el);
        });

        // Collect collection data
        document.querySelectorAll('[data-owl-collection]').forEach(container => {
            const collectionKey = container.getAttribute('data-owl-collection');
            const rows = container.querySelectorAll('[data-owl-index]');
            const items = [];

            rows.forEach(row => {
                const item = {};
                row.querySelectorAll('[data-owl-field]').forEach(el => {
                    item[el.getAttribute('data-owl-field')] = getFieldValue(el);
                });
                if (Object.keys(item).length > 0) items.push(item);
            });

            if (items.length > 0) {
                data[`_collection_${collectionKey}`] = items;
            }
        });

        return data;
    }

    function getFieldValue(element) {
        const tagName = element.tagName.toLowerCase();
        const type = (element.type || '').toLowerCase();

        if (tagName === 'input') {
            if (type === 'checkbox') return element.checked;
            if (type === 'radio') {
                const name = element.getAttribute('name');
                const checked = document.querySelector(`input[name="${name}"]:checked`);
                return checked ? checked.value : null;
            }
            if (type === 'number') return element.value ? Number(element.value) : null;
            if (type === 'file') return null;
            return element.value || null;
        }

        if (tagName === 'select') {
            if (element.multiple) {
                return Array.from(element.selectedOptions).map(o => o.value);
            }
            return element.value || null;
        }

        if (tagName === 'textarea') return element.value || null;

        return element.textContent || null;
    }

    // --- UI Feedback ---

    function showLoading(show) {
        let overlay = document.getElementById('owl-loading-overlay');
        if (show) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'owl-loading-overlay';
                overlay.innerHTML = `
                    <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.9);
                        display:flex;align-items:center;justify-content:center;z-index:99999;flex-direction:column;">
                        <div style="width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #1976d2;
                            border-radius:50%;animation:owlSpin 1s linear infinite;"></div>
                        <p style="margin-top:16px;color:#555;font-family:sans-serif;">Loading form...</p>
                    </div>
                    <style>@keyframes owlSpin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}</style>
                `;
                document.body.appendChild(overlay);
            }
            overlay.style.display = '';
        } else if (overlay) {
            overlay.remove();
        }
    }

    function showSubmitting(show) {
        let overlay = document.getElementById('owl-submitting-overlay');
        if (show) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'owl-submitting-overlay';
                overlay.innerHTML = `
                    <div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.9);
                        display:flex;align-items:center;justify-content:center;z-index:99999;flex-direction:column;">
                        <div style="width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #4caf50;
                            border-radius:50%;animation:owlSpin 1s linear infinite;"></div>
                        <p style="margin-top:16px;color:#555;font-family:sans-serif;">Submitting...</p>
                    </div>
                `;
                document.body.appendChild(overlay);
            }
            overlay.style.display = '';
        } else if (overlay) {
            overlay.remove();
        }
    }

    function showSuccess(message) {
        const container = document.getElementById('owl-form-container') || document.body;
        container.innerHTML = `
            <div style="max-width:500px;margin:80px auto;text-align:center;font-family:sans-serif;padding:40px;">
                <div style="width:60px;height:60px;background:#4caf50;border-radius:50%;margin:0 auto 20px;
                    display:flex;align-items:center;justify-content:center;">
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                </div>
                <h2 style="color:#333;margin-bottom:12px;">Thank You!</h2>
                <p style="color:#666;line-height:1.6;">${escapeHtml(message)}</p>
            </div>
        `;
    }

    function showError(message) {
        const container = document.getElementById('owl-form-container') || document.body;
        container.innerHTML = `
            <div style="max-width:500px;margin:80px auto;text-align:center;font-family:sans-serif;padding:40px;">
                <div style="width:60px;height:60px;background:#f44336;border-radius:50%;margin:0 auto 20px;
                    display:flex;align-items:center;justify-content:center;">
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </div>
                <h2 style="color:#333;margin-bottom:12px;">Unable to Load Form</h2>
                <p style="color:#666;line-height:1.6;">${escapeHtml(message)}</p>
            </div>
        `;
    }

    function showFormError(message) {
        let banner = document.getElementById('owl-error-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'owl-error-banner';
            const form = document.querySelector('form') || document.body.firstElementChild || document.body;
            form.parentNode.insertBefore(banner, form);
        }
        banner.innerHTML = `
            <div style="background:#fff3f3;border:1px solid #f44336;border-radius:8px;padding:12px 16px;
                margin:16px 0;display:flex;align-items:center;gap:10px;font-family:sans-serif;">
                <span style="color:#f44336;font-size:20px;">&#9888;</span>
                <span style="color:#c62828;">${escapeHtml(message)}</span>
            </div>
        `;
        banner.scrollIntoView({ behavior: 'smooth', block: 'center' });

        setTimeout(() => { if (banner) banner.remove(); }, 8000);
    }

    function showDraftIndicator() {
        let indicator = document.getElementById('owl-draft-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'owl-draft-indicator';
            indicator.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#333;color:#fff;' +
                'padding:8px 16px;border-radius:20px;font-family:sans-serif;font-size:13px;z-index:9999;' +
                'opacity:0;transition:opacity 0.3s;';
            document.body.appendChild(indicator);
        }
        indicator.textContent = 'Draft saved';
        indicator.style.opacity = '1';
        setTimeout(() => { indicator.style.opacity = '0'; }, 2500);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // --- Utility Methods ---

    function getToken() {
        return new URLSearchParams(window.location.search).get('token');
    }

    function getPrefillData() {
        return { ..._prefillData };
    }

    function getFormConfig() {
        return { ..._formConfig };
    }

    function isInitialized() {
        return _initialized;
    }

    function setFieldData(key, value) {
        _formData[key] = value;
    }

    function getVersion() {
        return VERSION;
    }

    // --- Mode Detection & Toolbars ---

    function getMode() {
        return new URLSearchParams(window.location.search).get('owl_mode') || 'live';
    }

    function initPreviewMode() {
        log('Initializing PREVIEW mode');
        injectPreviewToolbar();
        disableFormSubmission();
        markEditableFields();
    }

    function injectPreviewToolbar() {
        const toolbar = document.createElement('div');
        toolbar.id = 'owl-preview-toolbar';
        toolbar.innerHTML = `
            <div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#1976d2;color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.2);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:18px;">&#128065;</span>
                    <div>
                        <strong style="font-size:14px;">PREVIEW MODE</strong>
                        <span style="font-size:13px;opacity:0.9;margin-left:8px;">This is exactly what the customer will see</span>
                    </div>
                </div>
                <div style="display:flex;gap:10px;">
                    <button id="owl-approve-btn" style="padding:8px 20px;background:#4caf50;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">&#10003; Approve & Send</button>
                    <button id="owl-close-preview-btn" style="padding:8px 20px;background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.4);border-radius:6px;font-size:14px;cursor:pointer;">&#10005; Close</button>
                </div>
            </div>
        `;
        document.body.insertBefore(toolbar, document.body.firstChild);
        document.body.style.paddingTop = '60px';

        document.getElementById('owl-approve-btn').addEventListener('click', handleApproveAndSend);
        document.getElementById('owl-close-preview-btn').addEventListener('click', () => window.close());
    }

    function disableFormSubmission() {
        const forms = document.querySelectorAll('form');
        forms.forEach(form => {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                e.stopPropagation();
                alert('Form submission is disabled in Preview mode. Click "Approve & Send" to create the customer link.');
            });
        });
        const submitBtns = document.querySelectorAll('[type="submit"], .btn-submit');
        submitBtns.forEach(btn => {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.title = 'Disabled in preview mode';
        });
    }

    function markEditableFields() {
        const allFields = document.querySelectorAll('input:not([readonly]), textarea:not([readonly]), select');
        allFields.forEach(field => {
            if (!field.closest('#owl-preview-toolbar')) {
                field.style.border = '2px dashed #ff9800';
                field.placeholder = field.placeholder || '(Customer fills this)';
            }
        });
    }

    async function handleApproveAndSend() {
        const btn = document.getElementById('owl-approve-btn');
        btn.disabled = true;
        btn.textContent = 'Sending...';

        try {
            const email = prompt('Enter recipient email address:');
            if (!email) {
                btn.disabled = false;
                btn.innerHTML = '&#10003; Approve & Send';
                return;
            }

            const expiryDays = 30;
            const result = await apiCall('approve-send', 'POST', {
                previewToken: _config.token,
                recipientEmail: email,
                expiryDays: expiryDays
            });

            if (result.success) {
                btn.innerHTML = '&#10003; Sent!';
                btn.style.background = '#2e7d32';
                showApprovalSuccess(result.formUrl, email);
            } else {
                alert('Error: ' + (result.error || 'Failed to send'));
                btn.disabled = false;
                btn.innerHTML = '&#10003; Approve & Send';
            }
        } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
            btn.innerHTML = '&#10003; Approve & Send';
        }
    }

    function showApprovalSuccess(formUrl, email) {
        const toolbar = document.getElementById('owl-preview-toolbar');
        toolbar.innerHTML = `
            <div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#2e7d32;color:#fff;padding:16px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.2);">
                <div style="display:flex;align-items:center;justify-content:space-between;">
                    <div>
                        <strong style="font-size:15px;">&#10003; Form link created and ready!</strong>
                        <p style="margin:4px 0 0;font-size:13px;opacity:0.9;">Sent to: ${email}</p>
                    </div>
                    <div style="display:flex;gap:10px;">
                        <button onclick="navigator.clipboard.writeText('${formUrl}');this.textContent='Copied!'" style="padding:8px 16px;background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.4);border-radius:6px;font-size:13px;cursor:pointer;">Copy Link</button>
                        <button onclick="window.close()" style="padding:8px 16px;background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.4);border-radius:6px;font-size:13px;cursor:pointer;">Close</button>
                    </div>
                </div>
            </div>
        `;
    }

    // --- Mapper Mode ---

    function initMapperMode() {
        log('Initializing MAPPER mode');
        const taggedFields = [];
        const state = { mode: 'tag' }; // 'tag' or 'navigate'
        injectMapperToolbar(taggedFields, state);
        enableClickToTag(taggedFields, state);
    }

    function injectMapperToolbar(taggedFields, state) {
        const toolbar = document.createElement('div');
        toolbar.id = 'owl-mapper-toolbar';
        toolbar.innerHTML = `
            <div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#333;color:#fff;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,0.3);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:18px;">&#127919;</span>
                    <div>
                        <strong style="font-size:14px;">MAPPER MODE</strong>
                        <span style="font-size:13px;opacity:0.8;margin-left:8px;">Click elements to tag them for Salesforce mapping</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                    <div id="owl-mode-toggle" style="display:flex;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.3);">
                        <button id="owl-mode-tag" style="padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:#1976d2;color:#fff;">&#127919; Tag</button>
                        <button id="owl-mode-nav" style="padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.7);">&#9654; Navigate</button>
                    </div>
                    <span id="owl-mapper-count" style="font-size:13px;opacity:0.8;">0 fields tagged</span>
                    <button id="owl-save-mappings-btn" style="padding:8px 20px;background:#1976d2;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Save to Salesforce</button>
                    <button id="owl-done-mapper-btn" style="padding:8px 20px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:6px;font-size:14px;cursor:pointer;">Done</button>
                </div>
            </div>
        `;
        document.body.insertBefore(toolbar, document.body.firstChild);
        document.body.style.paddingTop = '60px';

        document.getElementById('owl-save-mappings-btn').addEventListener('click', () => saveMappingsToSF(taggedFields));
        document.getElementById('owl-done-mapper-btn').addEventListener('click', () => window.close());

        document.getElementById('owl-mode-tag').addEventListener('click', () => {
            state.mode = 'tag';
            document.getElementById('owl-mode-tag').style.background = '#1976d2';
            document.getElementById('owl-mode-tag').style.color = '#fff';
            document.getElementById('owl-mode-nav').style.background = 'rgba(255,255,255,0.1)';
            document.getElementById('owl-mode-nav').style.color = 'rgba(255,255,255,0.7)';
            document.body.style.cursor = 'crosshair';
        });

        document.getElementById('owl-mode-nav').addEventListener('click', () => {
            state.mode = 'navigate';
            document.getElementById('owl-mode-nav').style.background = '#4caf50';
            document.getElementById('owl-mode-nav').style.color = '#fff';
            document.getElementById('owl-mode-tag').style.background = 'rgba(255,255,255,0.1)';
            document.getElementById('owl-mode-tag').style.color = 'rgba(255,255,255,0.7)';
            document.body.style.cursor = '';
        });

        document.body.style.cursor = 'crosshair';
    }

    function enableClickToTag(taggedFields, state) {
        let lastHighlighted = null;
        let currentElement = null;
        let hoverEl = null;
        const taggedElements = []; // Direct references to tagged elements + their labels

        // Create a fixed overlay container for tag labels
        const labelOverlay = document.createElement('div');
        labelOverlay.id = 'owl-label-overlay';
        labelOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99990;';
        document.body.appendChild(labelOverlay);

        function repositionLabels() {
            taggedElements.forEach(item => {
                const rect = item.el.getBoundingClientRect();
                item.label.style.top = (rect.top - 14) + 'px';
                item.label.style.left = rect.left + 'px';
            });
        }
        window.addEventListener('scroll', repositionLabels, true);
        window.addEventListener('resize', repositionLabels);

        // Hover highlight — never touch tagged elements
        document.addEventListener('mouseover', (e) => {
            if (state.mode !== 'tag') return;
            const t = e.target;
            if (t.closest('#owl-mapper-toolbar') || t.closest('#owl-tag-popup') || t.closest('#owl-label-overlay')) return;
            if (t === document.body || t === document.documentElement) return;
            if (t.getAttribute('data-owl-tagged')) return; // Don't hover-highlight tagged elements
            if (hoverEl && hoverEl !== lastHighlighted && !hoverEl.getAttribute('data-owl-tagged')) {
                hoverEl.style.outline = '';
            }
            if (t !== lastHighlighted) {
                t.style.outline = '2px dashed #2196f3';
                hoverEl = t;
            }
        }, true);
        document.addEventListener('mouseout', (e) => {
            if (hoverEl && hoverEl !== lastHighlighted && !hoverEl.getAttribute('data-owl-tagged')) {
                hoverEl.style.outline = '';
                hoverEl = null;
            }
        }, true);

        function addTagLabel(el, key) {
            // Remove existing label for this element if re-tagging
            const existingIdx = taggedElements.findIndex(item => item.el === el);
            if (existingIdx > -1) {
                taggedElements[existingIdx].label.remove();
                taggedElements.splice(existingIdx, 1);
            }

            const rect = el.getBoundingClientRect();
            const label = document.createElement('span');
            label.className = 'owl-tag-label';
            label.textContent = key;
            label.style.cssText = `position:fixed;top:${rect.top - 14}px;left:${rect.left}px;background:#4caf50;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;font-family:monospace;pointer-events:none;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
            labelOverlay.appendChild(label);
            taggedElements.push({ el, label });
        }

        function selectElement(el) {
            if (lastHighlighted && !lastHighlighted.getAttribute('data-owl-tagged')) {
                lastHighlighted.style.outline = '';
            }
            el.style.outline = '3px solid #ff5722';
            lastHighlighted = el;
            currentElement = el;
            showTagPopup(el, taggedFields, {
                onParent: () => {
                    if (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement) {
                        selectElement(el.parentElement);
                    }
                },
                onChild: () => {
                    const child = el.firstElementChild;
                    if (child) selectElement(child);
                },
                onNextSibling: () => {
                    const sib = el.nextElementSibling;
                    if (sib) selectElement(sib);
                }
            }, addTagLabel);
        }

        document.addEventListener('click', (e) => {
            if (e.target.closest('#owl-mapper-toolbar') || e.target.closest('#owl-tag-popup') || e.target.closest('#owl-label-overlay')) return;

            if (state.mode === 'navigate') return;

            e.preventDefault();
            e.stopPropagation();

            let target = e.target;

            if (target === document.body || target === document.documentElement) {
                const elements = document.elementsFromPoint(e.clientX, e.clientY);
                for (const el of elements) {
                    if (el.closest('#owl-mapper-toolbar') || el.closest('#owl-tag-popup') || el.closest('#owl-label-overlay')) continue;
                    if (el === document.body || el === document.documentElement) continue;
                    target = el;
                    break;
                }
            }

            if (target === document.body || target === document.documentElement) return;

            selectElement(target);
        }, true);
    }

    function showTagPopup(element, taggedFields, nav, addTagLabel) {
        let popup = document.getElementById('owl-tag-popup');
        if (popup) popup.remove();

        const existingKey = element.getAttribute('data-owl-field') || element.getAttribute('name') || element.id || '';
        const tag = element.tagName.toLowerCase();
        const fieldType = tag === 'select' ? 'Picklist'
            : element.type === 'checkbox' ? 'Checkbox'
            : element.type === 'number' ? 'Number'
            : element.type === 'email' ? 'Email'
            : element.type === 'date' ? 'Date'
            : tag === 'textarea' ? 'LongText'
            : 'Text';

        const textPreview = (element.textContent || '').trim().substring(0, 50);
        const childCount = element.children.length;
        const hasParent = element.parentElement && element.parentElement !== document.body;
        const hasSibling = !!element.nextElementSibling;

        // Build datalist options from previously tagged keys
        const existingKeys = taggedFields.map(f => f.fieldKey);
        const uniqueKeys = [...new Set(existingKeys)];
        const datalistOptions = uniqueKeys.map(k => `<option value="${k}">`).join('');

        popup = document.createElement('div');
        popup.id = 'owl-tag-popup';
        popup.innerHTML = `
            <div style="position:fixed;bottom:20px;right:20px;z-index:100000;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);padding:20px;width:340px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
                <p style="margin:0 0 4px;font-size:12px;color:#666;">Element: <strong>&lt;${tag}&gt;</strong> ${element.className ? '.' + element.className.split(' ')[0] : ''} ${element.id ? '#' + element.id : ''}</p>
                <p style="margin:0 0 4px;font-size:11px;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Preview: "${textPreview}${textPreview.length >= 50 ? '...' : ''}"</p>
                <p style="margin:0 0 8px;font-size:11px;color:#999;">Children: ${childCount} | Type: ${fieldType}</p>
                <div style="display:flex;gap:4px;margin-bottom:12px;">
                    <button id="owl-nav-parent" style="flex:1;padding:5px;background:${hasParent ? '#e3f2fd' : '#f5f5f5'};color:${hasParent ? '#1565c0' : '#bbb'};border:1px solid ${hasParent ? '#90caf9' : '#eee'};border-radius:4px;font-size:11px;cursor:${hasParent ? 'pointer' : 'default'};" ${hasParent ? '' : 'disabled'}>↑ Parent</button>
                    <button id="owl-nav-child" style="flex:1;padding:5px;background:${childCount ? '#e8f5e9' : '#f5f5f5'};color:${childCount ? '#2e7d32' : '#bbb'};border:1px solid ${childCount ? '#a5d6a7' : '#eee'};border-radius:4px;font-size:11px;cursor:${childCount ? 'pointer' : 'default'};" ${childCount ? '' : 'disabled'}>↓ Child</button>
                    <button id="owl-nav-sibling" style="flex:1;padding:5px;background:${hasSibling ? '#fff3e0' : '#f5f5f5'};color:${hasSibling ? '#e65100' : '#bbb'};border:1px solid ${hasSibling ? '#ffcc80' : '#eee'};border-radius:4px;font-size:11px;cursor:${hasSibling ? 'pointer' : 'default'};" ${hasSibling ? '' : 'disabled'}>→ Sibling</button>
                </div>
                <label style="display:block;font-size:12px;font-weight:600;color:#333;margin-bottom:4px;">Field Key</label>
                <input id="owl-tag-key" type="text" list="owl-key-suggestions" value="${existingKey}" placeholder="e.g. dispenser_title" style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:10px;box-sizing:border-box;">
                <datalist id="owl-key-suggestions">${datalistOptions}</datalist>
                <label style="display:block;font-size:12px;font-weight:600;color:#333;margin-bottom:4px;">Direction</label>
                <select id="owl-tag-direction" style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;margin-bottom:12px;box-sizing:border-box;">
                    <option value="Pre_fill">Pre-fill (SF → Form)</option>
                    <option value="Write_back">Write-back (Form → SF)</option>
                    <option value="Both">Both</option>
                </select>
                <div style="display:flex;gap:8px;">
                    <button id="owl-tag-add" style="flex:1;padding:8px;background:#1976d2;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Tag Field</button>
                    <button id="owl-tag-cancel" style="flex:1;padding:8px;background:#f5f5f5;color:#333;border:1px solid #ddd;border-radius:6px;font-size:13px;cursor:pointer;">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(popup);

        document.getElementById('owl-nav-parent').addEventListener('click', () => { if (nav && nav.onParent) nav.onParent(); });
        document.getElementById('owl-nav-child').addEventListener('click', () => { if (nav && nav.onChild) nav.onChild(); });
        document.getElementById('owl-nav-sibling').addEventListener('click', () => { if (nav && nav.onNextSibling) nav.onNextSibling(); });

        document.getElementById('owl-tag-add').addEventListener('click', () => {
            const key = document.getElementById('owl-tag-key').value.trim();
            const direction = document.getElementById('owl-tag-direction').value;
            if (!key) { alert('Field key is required.'); return; }

            taggedFields.push({
                fieldKey: key,
                fieldLabel: key,
                direction: direction,
                fieldType: fieldType,
                cssSelector: buildCssSelector(element),
                isRequired: false,
                isReadOnly: direction === 'Pre_fill'
            });

            element.style.outline = '3px solid #4caf50';
            element.setAttribute('data-owl-tagged', 'true');
            if (addTagLabel) addTagLabel(element, key);
            document.getElementById('owl-mapper-count').textContent = taggedFields.length + ' fields tagged';
            popup.remove();
        });

        document.getElementById('owl-tag-cancel').addEventListener('click', () => {
            popup.remove();
            if (!element.getAttribute('data-owl-tagged')) {
                element.style.outline = '';
            }
        });
    }

    function buildCssSelector(el) {
        if (el.id) return '#' + el.id;
        if (el.getAttribute('data-owl-field')) return '[data-owl-field="' + el.getAttribute('data-owl-field') + '"]';
        if (el.getAttribute('name')) return '[name="' + el.getAttribute('name') + '"]';
        return el.tagName.toLowerCase();
    }

    async function saveMappingsToSF(taggedFields) {
        if (taggedFields.length === 0) {
            alert('No fields tagged yet. Click on form elements to tag them.');
            return;
        }

        const btn = document.getElementById('owl-save-mappings-btn');
        btn.disabled = true;
        btn.textContent = 'Saving...';

        // Get baseUrl from: URL param > meta tag > localStorage (no prompt needed - Admin App passes it)
        let baseUrl = new URLSearchParams(window.location.search).get('owl_base_url')
            || document.querySelector('meta[name="owl-base-url"]')?.content
            || localStorage.getItem('owl_base_url')
            || '';

        if (!baseUrl) {
            alert('Unable to save: Salesforce Site URL not configured. Please launch the mapper from the Admin App.');
            btn.disabled = false;
            btn.textContent = 'Save to Salesforce';
            return;
        }

        baseUrl = decodeURIComponent(baseUrl).replace(/\/+$/, '');
        localStorage.setItem('owl_base_url', baseUrl);

        const formId = new URLSearchParams(window.location.search).get('formId')
            || new URLSearchParams(window.location.search).get('token')
            || '';

        _config.baseUrl = baseUrl;

        try {
            const result = await apiCall('admin/mappings', 'POST', {
                formId: formId,
                mappings: taggedFields
            });

            if (result.data && result.data.success) {
                btn.textContent = '✓ Saved ' + (result.data.savedCount || taggedFields.length) + ' mappings';
                btn.style.background = '#4caf50';
            } else {
                alert('Error saving: ' + ((result.data && result.data.error) || 'Unknown error'));
                btn.disabled = false;
                btn.textContent = 'Save to Salesforce';
            }
        } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Save to Salesforce';
        }
    }

    function downloadMappingsJSON(payload) {
        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'owl-mappings-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('Mappings downloaded! You can import this file in the Admin App > Form Editor > Mappings tab.');
    }

    // --- Public API ---

    global.OwlForms = {
        init: init,
        submit: submit,
        saveDraft: saveDraft,
        collectFormData: collectFormData,
        getPrefillData: getPrefillData,
        getFormConfig: getFormConfig,
        getToken: getToken,
        setFieldData: setFieldData,
        isInitialized: isInitialized,
        getVersion: getVersion,
        applyPrefill: applyPrefill,
        applyConditions: applyConditions,
        getMode: getMode,
        captureFormPdf: captureFormPdf,

        _internal: {
            findFieldElements: findFieldElements,
            setFieldValue: setFieldValue,
            getFieldValue: getFieldValue,
            initPreviewMode: initPreviewMode,
            initMapperMode: initMapperMode
        }
    };

    // --- Auto-init for Preview & Mapper modes ---
    document.addEventListener('DOMContentLoaded', () => {
        const mode = getMode();
        if (mode === 'preview' || mode === 'mapper') {
            const token = getToken();
            const baseUrl = document.querySelector('meta[name="owl-base-url"]')?.content
                || localStorage.getItem('owl_base_url')
                || '';

            if (mode === 'preview' && token && baseUrl) {
                init({ baseUrl, token, debug: true }).then(() => initPreviewMode());
            } else if (mode === 'preview' && token) {
                _config.token = token;
                initPreviewMode();
            } else if (mode === 'mapper') {
                _config.token = token;
                initMapperMode();
            }
        }
    });

})(typeof window !== 'undefined' ? window : this);
