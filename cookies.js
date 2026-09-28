(() => {
    const storageKey = 'modeos-cookie-consent';
    const consentVersion = 1;
    const optionalCategories = ['analytics', 'personalization'];
    let consent = null;
    let previousFocus = null;
    let memoryConsent = null;

    function defaultConsent() {
        return {
            version: consentVersion,
            necessary: true,
            analytics: false,
            personalization: false,
            decidedAt: null
        };
    }

    function readConsent() {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (saved?.version !== consentVersion || saved.necessary !== true || !saved.decidedAt) return null;
            if (!Number.isFinite(Date.parse(saved.decidedAt))) return null;
            return {
                version: consentVersion,
                necessary: true,
                analytics: saved.analytics === true,
                personalization: saved.personalization === true,
                decidedAt: saved.decidedAt
            };
        } catch {
            return memoryConsent;
        }
    }

    function writeConsent(nextConsent) {
        consent = {
            version: consentVersion,
            necessary: true,
            analytics: nextConsent.analytics === true,
            personalization: nextConsent.personalization === true,
            decidedAt: new Date().toISOString()
        };
        memoryConsent = consent;
        try {
            localStorage.setItem(storageKey, JSON.stringify(consent));
        } catch {
            // Optional tracking remains governed by the in-memory choice for this visit.
        }
        applyConsent();
    }

    function syncSwitches() {
        document.querySelectorAll('[data-cookie-toggle]').forEach(toggle => {
            const category = toggle.dataset.cookieToggle;
            toggle.setAttribute('aria-checked', String(consent[category] === true));
        });
    }

    function updateGtagConsent() {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
        window.gtag('consent', 'update', {
            analytics_storage: consent.analytics ? 'granted' : 'denied',
            functionality_storage: consent.personalization ? 'granted' : 'denied',
            personalization_storage: consent.personalization ? 'granted' : 'denied',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
            security_storage: 'granted'
        });
    }

    function activateConsentedScripts() {
        document.querySelectorAll('script[type="text/plain"][data-consent-category][data-consent-src]').forEach(source => {
            const category = source.dataset.consentCategory;
            if (!optionalCategories.includes(category) || !consent[category] || source.dataset.consentLoaded === 'true') return;
            const script = document.createElement('script');
            script.src = source.dataset.consentSrc;
            script.async = true;
            script.dataset.consentCategory = category;
            if (source.dataset.integrity) script.integrity = source.dataset.integrity;
            if (source.dataset.crossorigin) script.crossOrigin = source.dataset.crossorigin;
            source.dataset.consentLoaded = 'true';
            document.head.append(script);
        });
    }

    function applyConsent() {
        syncSwitches();
        updateGtagConsent();
        activateConsentedScripts();
        window.dispatchEvent(new CustomEvent('modeos:cookie-consent', { detail: { ...consent } }));
        const banner = document.getElementById('cookie-banner');
        if (banner) banner.hidden = Boolean(consent.decidedAt);
    }

    function openPreferences() {
        const dialog = document.getElementById('cookie-preferences');
        if (!dialog) return;
        previousFocus = document.activeElement;
        syncSwitches();
        dialog.hidden = false;
        document.body.classList.add('cookie-dialog-open');
        dialog.querySelector('.cookie-dialog').focus();
        dialog.querySelector('[data-cookie-action="close"]').focus();
    }

    function closePreferences() {
        const dialog = document.getElementById('cookie-preferences');
        if (!dialog || dialog.hidden) return;
        dialog.hidden = true;
        document.body.classList.remove('cookie-dialog-open');
        if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }

    function acceptAll() {
        writeConsent({ analytics: true, personalization: true });
        closePreferences();
    }

    function rejectOptional() {
        writeConsent({ analytics: false, personalization: false });
        closePreferences();
    }

    function saveSelection() {
        const selected = {};
        document.querySelectorAll('[data-cookie-toggle]').forEach(toggle => {
            selected[toggle.dataset.cookieToggle] = toggle.getAttribute('aria-checked') === 'true';
        });
        writeConsent(selected);
        closePreferences();
    }

    function toggleCategory(toggle) {
        const enabled = toggle.getAttribute('aria-checked') === 'true';
        toggle.setAttribute('aria-checked', String(!enabled));
    }

    function handleDialogKeys(event) {
        if (event.key === 'Escape') {
            closePreferences();
            return;
        }
        if (event.key !== 'Tab') return;
        const dialog = document.querySelector('#cookie-preferences .cookie-dialog');
        if (!dialog) return;
        const focusable = [...dialog.querySelectorAll('button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function ensureCookieInterface() {
        if (document.getElementById('cookie-banner') && document.getElementById('cookie-preferences')) return;
        document.body.insertAdjacentHTML('beforeend', `
            <section id="cookie-banner" class="cookie-banner" role="region" aria-label="Preferencias de cookies" hidden>
                <div class="cookie-banner-copy">
                    <span class="cookie-eyebrow">PRIVACIDAD</span>
                    <h2>Tu privacidad, a tu manera</h2>
                    <p>La analítica y personalización opcionales permanecen apagadas hasta que las autorices.</p>
                    <a href="cookies-policy.html">Leer la política de cookies</a>
                </div>
                <div class="cookie-banner-actions">
                    <button type="button" class="cookie-button cookie-button-quiet" data-cookie-action="reject">Rechazar opcionales</button>
                    <button type="button" class="cookie-button cookie-button-secondary" data-cookie-action="configure">Configurar</button>
                    <button type="button" class="cookie-button cookie-button-primary" data-cookie-action="accept">Aceptar todas</button>
                </div>
            </section>
            <div id="cookie-preferences" class="cookie-dialog-backdrop" role="presentation" hidden>
                <section class="cookie-dialog" role="dialog" aria-modal="true" aria-labelledby="cookie-dialog-title" aria-describedby="cookie-dialog-description" tabindex="-1">
                    <header class="cookie-dialog-header">
                        <div><span class="cookie-eyebrow">CENTRO DE PRIVACIDAD</span><h2 id="cookie-dialog-title">Configuración avanzada</h2></div>
                        <button type="button" class="cookie-close" data-cookie-action="close" aria-label="Cerrar preferencias">×</button>
                    </header>
                    <p id="cookie-dialog-description" class="cookie-dialog-intro">Elige qué categorías opcionales autorizas. Puedes cambiar o retirar tu decisión cuando quieras.</p>
                    <div class="cookie-category-list">
                        <article class="cookie-category"><div class="cookie-category-copy"><h3>Cookies esenciales</h3><p>Necesarias para recordar tu elección y proteger funciones solicitadas. Siempre activas.</p></div><span class="cookie-required">Obligatorias</span></article>
                        <article class="cookie-category"><div class="cookie-category-copy"><h3>Analítica y rendimiento</h3><p>Ayudan a medir el uso y detectar errores. Desactivadas por defecto.</p></div><button type="button" class="cookie-switch" role="switch" aria-checked="false" aria-label="Permitir cookies analíticas" data-cookie-toggle="analytics"><span></span></button></article>
                        <article class="cookie-category"><div class="cookie-category-copy"><h3>Personalización y preferencias</h3><p>Recuerdan opciones no esenciales entre visitas. Desactivadas por defecto.</p></div><button type="button" class="cookie-switch" role="switch" aria-checked="false" aria-label="Permitir cookies de personalización" data-cookie-toggle="personalization"><span></span></button></article>
                    </div>
                    <p class="cookie-vendor-note">La elección se guarda en este navegador y puede modificarse desde el pie de página.</p>
                    <footer class="cookie-dialog-actions">
                        <button type="button" class="cookie-button cookie-button-quiet" data-cookie-action="reject">Rechazar opcionales</button>
                        <button type="button" class="cookie-button cookie-button-secondary" data-cookie-action="save">Guardar selección</button>
                        <button type="button" class="cookie-button cookie-button-primary" data-cookie-action="accept">Aceptar todas</button>
                    </footer>
                </section>
            </div>`);
    }

    function initializeCookieConsent() {
        ensureCookieInterface();
        const banner = document.getElementById('cookie-banner');
        const dialog = document.getElementById('cookie-preferences');

        consent = readConsent() || defaultConsent();
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
        window.gtag('consent', 'default', {
            analytics_storage: 'denied',
            functionality_storage: 'denied',
            personalization_storage: 'denied',
            ad_storage: 'denied',
            ad_user_data: 'denied',
            ad_personalization: 'denied',
            security_storage: 'granted'
        });
        applyConsent();

        document.querySelectorAll('[data-cookie-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.cookieAction;
                if (action === 'accept') acceptAll();
                if (action === 'reject') rejectOptional();
                if (action === 'configure') openPreferences();
                if (action === 'save') saveSelection();
                if (action === 'close') closePreferences();
            });
        });
        document.querySelectorAll('[data-cookie-open]').forEach(button => button.addEventListener('click', event => {
            if (button instanceof HTMLAnchorElement) event.preventDefault();
            openPreferences();
        }));
        document.querySelectorAll('[data-cookie-toggle]').forEach(toggle => toggle.addEventListener('click', () => toggleCategory(toggle)));
        dialog.addEventListener('click', event => {
            if (event.target === dialog) closePreferences();
        });
        dialog.addEventListener('keydown', handleDialogKeys);
        window.addEventListener('storage', event => {
            if (event.key !== storageKey) return;
            consent = readConsent() || defaultConsent();
            applyConsent();
        });
        if (window.location.hash === '#cookie-settings') openPreferences();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeCookieConsent, { once: true });
    } else {
        initializeCookieConsent();
    }
})();
