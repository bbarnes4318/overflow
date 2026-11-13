/* NetEnroll interactions for /, /medicare-tv-calls and /final-expense-tv-calls.
   Loaded after site.js (menu, reveals, window.NE.track). Every page reads and
   every link works without it; the lead form's JSON submit and the homepage
   contact dialog need it. No framework, no dependencies. */
(function () {
    'use strict';
    var track = function (e, p) { if (window.NE) window.NE.track(e, p); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    /* ---- Header: hairline once the page scrolls ------------------------------ */
    var head = document.querySelector('.nx-head');
    if (head) {
        var onScroll = function () { head.classList.toggle('is-stuck', window.scrollY > 8); };
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
    }

    /* ---- Homepage contact dialog: every #contact link opens it -------------- */
    var dlg = document.getElementById('contact');
    if (dlg && dlg.tagName === 'DIALOG' && typeof dlg.showModal === 'function') {
        var opener = null;
        var open = function (loc) {
            if (dlg.open) return;
            opener = document.activeElement;
            dlg.showModal();
            track('contact_open', { location: loc || '' });
        };
        document.addEventListener('click', function (e) {
            var a = e.target.closest('a[href="#contact"]');
            if (!a) return;
            e.preventDefault();
            open(a.getAttribute('data-loc'));
        });
        dlg.addEventListener('click', function (e) {
            if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
        });
        dlg.addEventListener('close', function () {
            if (location.hash === '#contact') history.replaceState(null, '', location.pathname + location.search);
            if (opener && opener.focus) opener.focus();
        });
        if (location.hash === '#contact') open('hash');
    }

    /* ---- Campaign attribution: kept for the session, sent with the form ------- */
    var attr = null;
    try {
        attr = JSON.parse(sessionStorage.getItem('ne_attr') || 'null');
        if (!attr) {
            var q = new URLSearchParams(location.search), a = { landing: location.pathname };
            ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { if (q.get(k)) a[k] = q.get(k); });
            if (document.referrer && document.referrer.indexOf(location.host) === -1) a.referrer = document.referrer;
            attr = a;
            sessionStorage.setItem('ne_attr', JSON.stringify(a));
        }
    } catch (e) { attr = { landing: location.pathname }; }

    /* ---- Lead form: two short steps, one request ---------------------------- */
    $$('[data-lead]').forEach(function (form) {
        var panes = $$('[data-pane]', form), bars = $$('.lead-steps i', form);
        var err = form.querySelector('.lead-error'), done = document.getElementById(form.getAttribute('data-done'));
        var btn = form.querySelector('[type="submit"]'), btnText = btn.innerHTML;
        var cur = 1, started = false, sending = false;

        // ?product=medicare|final_expense|both preselects, overriding the page default.
        var want = new URLSearchParams(location.search).get('product');
        if (want) $$('input[name="products"]', form).forEach(function (c) { c.checked = want === 'both' || c.value === want; });

        function msg(el) {
            if (el.validity.valueMissing) return el.tagName === 'SELECT' ? 'Choose one.' : 'Required.';
            if (el.validity.typeMismatch) return 'That email address looks incomplete.';
            return el.validationMessage || 'Please check this field.';
        }
        function check(el) {
            el.setCustomValidity('');
            if (el.name === 'phone' && el.value && el.value.replace(/\D/g, '').length < 10) el.setCustomValidity('Enter a 10-digit phone number.');
            var ok = el.checkValidity(), wrap = el.closest('.field'), e = document.getElementById(el.id + '-err');
            if (wrap) wrap.classList.toggle('is-invalid', !ok);
            el.setAttribute('aria-invalid', String(!ok));
            if (e) e.textContent = ok ? '' : msg(el);
            return ok;
        }
        function paneOk(n) {
            var pane = panes[n - 1], bad = $$('input:not([type="checkbox"]), select, textarea', pane).filter(function (el) { return el.name && !check(el); });
            var boxes = $$('input[name="products"]', pane), pe = pane.querySelector('[data-products-err]');
            if (boxes.length) {
                var any = boxes.some(function (c) { return c.checked; });
                if (pe) pe.textContent = any ? '' : 'Choose at least one program.';
                if (!any) bad.unshift(boxes[0]);
            }
            if (bad.length) { bad[0].focus(); return false; }
            return true;
        }
        function go(n) {
            cur = n;
            panes.forEach(function (p, i) { p.hidden = i + 1 !== n; });
            bars.forEach(function (b, i) { b.classList.toggle('on', i < n); });
            var first = panes[n - 1].querySelector('input:not([type="checkbox"]), select');
            if (first) first.focus({ preventScroll: true });
            track('lead_form_step', { step: n, source: form.getAttribute('data-source') });
        }
        form.addEventListener('focusin', function () { if (!started) { started = true; track('lead_form_start', { source: form.getAttribute('data-source') }); } });
        form.addEventListener('blur', function (e) { if (e.target.matches('input:not([type="checkbox"]), select, textarea') && e.target.value) check(e.target); }, true);
        form.addEventListener('click', function (e) {
            if (e.target.closest('[data-next]')) { if (paneOk(cur)) go(cur + 1); }
            else if (e.target.closest('[data-back]')) go(cur - 1);
        });
        form.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && cur < panes.length && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit' && e.target.type !== 'button') {
                e.preventDefault(); if (paneOk(cur)) go(cur + 1);
            }
        });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            if (sending) return;                              // no double submits
            for (var i = 1; i <= panes.length; i++) if (!paneOk(i)) { if (i !== cur) go(i); return; }
            if (form.website && form.website.value) return;   // honeypot
            var fd = new FormData(form), body = {};
            fd.forEach(function (v, k) { if (k !== 'products' && k !== 'website') body[k] = v; });
            body.products = fd.getAll('products');
            body.source = form.getAttribute('data-source');
            body.attribution = attr;
            sending = true; btn.disabled = true; btn.textContent = 'Sending…';
            err.classList.remove('is-on');
            fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) })
                .then(function (res) {
                    return res.json().catch(function () { return {}; }).then(function (d) { if (!res.ok) throw new Error(d.error || 'The request could not be sent.'); return d; });
                })
                .then(function (d) {
                    form.hidden = true; done.hidden = false; done.setAttribute('tabindex', '-1'); done.focus();
                    track('lead_form_success', { id: d.id || null, products: body.products.join(','), source: body.source });
                    track('generate_lead', { products: body.products.join(','), source: body.source });
                })
                .catch(function (x) {
                    err.textContent = (x.message || 'The request could not be sent.') + ' Your answers are still here. Try again, or call 904-512-8487.';
                    err.classList.add('is-on');
                    sending = false; btn.disabled = false; btn.innerHTML = btnText;
                    track('lead_form_error', { message: x.message || '' });
                });
        });
    });
})();
