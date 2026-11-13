/* NetEnroll "Inbound Signal" interactions, for /, /medicare-tv-calls and
   /final-expense-tv-calls. Loaded after site.js (menu, reveals, sticky CTA,
   window.NE.track). Every page reads and every link and form works without it
   except the form's JSON submit, which falls back to the call-us message.
   No framework, no dependencies. */
(function () {
    'use strict';
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var track = function (e, p) { if (window.NE) window.NE.track(e, p); };
    var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

    /* ---- Header: glass once the page scrolls --------------------------------- */
    var head = document.querySelector('.nx-head');
    if (head) {
        var onScroll = function () { head.classList.toggle('is-stuck', window.scrollY > 8); };
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
    }

    /* ---- Loops run only while on screen, never under reduced motion ---------- */
    var live = $$('[data-live]');
    if (!reduced && 'IntersectionObserver' in window) {
        var lo = new IntersectionObserver(function (en) {
            en.forEach(function (e) { e.target.classList.toggle('sig-live', e.isIntersecting); });
        }, { rootMargin: '80px' });
        live.forEach(function (el) { lo.observe(el); });
    }

    /* ---- Product panels: the light follows the pointer ----------------------- */
    if (!reduced) {
        $$('.prod').forEach(function (p) {
            p.addEventListener('pointermove', function (e) {
                var r = p.getBoundingClientRect();
                p.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
                p.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
            });
        });
    }

    var fmt = function (s) { s = Math.round(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
    var BUFFER = 120;

    /* ---- The buffer meter --------------------------------------------------- */
    $$('[data-meter]').forEach(function (m) {
        var range = m.querySelector('input[type="range"]');
        var time = m.querySelector('[data-time]'), state = m.querySelector('[data-state]'), cost = m.querySelector('[data-cost]');
        var bars = m.querySelector('.meter-bars'), play = m.querySelector('[data-play]');
        var prices = { med: Number(m.getAttribute('data-price-med') || 39), fe: Number(m.getAttribute('data-price-fe') || 44) };
        var max = Number(range.max), N = 60, raf = 0, wasBillable = null;
        for (var i = 0; i < N; i++) {
            var b = document.createElement('i');
            var h = 22 + Math.abs(Math.sin(i * 1.7) * 52 + Math.sin(i * .37) * 26);
            b.style.setProperty('--h', Math.min(100, h).toFixed(0) + '%');
            bars.appendChild(b);
        }
        var cells = bars.children;
        function paint() {
            var s = Number(range.value), prod = m.getAttribute('data-prod') || 'med';
            var billable = s >= BUFFER;
            time.firstChild.nodeValue = fmt(s);
            state.textContent = billable ? 'Billable call' : 'Not billable';
            cost.textContent = billable ? '$' + prices[prod] : '$0';
            m.classList.toggle('is-billable', billable);
            range.setAttribute('aria-valuetext', fmt(s) + ', ' + (billable ? 'billable at $' + prices[prod] : 'not billable'));
            var on = Math.round(s / max * N);
            for (var j = 0; j < N; j++) { cells[j].classList.toggle('on', j < on); cells[j].classList.toggle('paid', j >= N / 2); }
            if (billable !== wasBillable && wasBillable !== null && !reduced) cost.animate([{ transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.75,.1,1)' });
            wasBillable = billable;
        }
        range.addEventListener('input', function () { stop(); paint(); });
        range.addEventListener('change', function () { track('buffer_meter', { seconds: Number(range.value), product: m.getAttribute('data-prod') }); });
        $$('input[name="' + m.id + '-prod"]', m).forEach(function (r) {
            r.addEventListener('change', function () { m.setAttribute('data-prod', r.value); paint(); track('buffer_product', { product: r.value }); });
        });
        function stop() { cancelAnimationFrame(raf); raf = 0; if (play) play.querySelector('span').textContent = 'Play a call'; }
        if (play) play.addEventListener('click', function () {
            if (raf) { stop(); return; }
            if (reduced) { range.value = 150; paint(); return; }
            var start = Number(range.value) >= max - 2 ? 0 : Number(range.value), t0 = performance.now();
            play.querySelector('span').textContent = 'Pause';
            track('buffer_play', { product: m.getAttribute('data-prod') });
            (function step(t) {
                var s = Math.min(max, start + (t - t0) / 1000 * 30);  // 30x real time
                range.value = s; paint();
                if (s < max) raf = requestAnimationFrame(step); else stop();
            })(t0);
        });
        paint();
    });

    /* ---- Call card (product heroes): a call ticks past the buffer, on loop ---- */
    $$('[data-callcard]').forEach(function (card) {
        var cc = card.querySelector('.cc'), f = card.querySelector('.cc-dial .f'), t = card.querySelector('[data-cc-time]');
        var lbl = card.querySelector('[data-cc-state]'), bill = card.querySelector('[data-cc-bill]');
        var price = card.getAttribute('data-price'), MAX = 180, raf = 0, visible = false;
        function show(s) {
            var billable = s >= BUFFER;
            f.style.strokeDasharray = (s / MAX * 100).toFixed(2) + ' 100';
            t.textContent = fmt(s);
            lbl.textContent = billable ? 'Billable' : 'Buffer';
            bill.textContent = billable ? '$' + price : '$0';
            cc.classList.toggle('is-billable', billable);
        }
        if (reduced || !('IntersectionObserver' in window)) { show(134); return; }
        function loop() {
            var t0 = performance.now();
            (function step(now) {
                if (!visible) { raf = 0; return; }
                var e = (now - t0) / 1000;               // 0-7.5s: 0 to 150s of call, then hold
                var s = Math.min(150, e * 20);
                show(s);
                if (e < 10) raf = requestAnimationFrame(step); else loop();
            })(t0);
        }
        new IntersectionObserver(function (en) {
            visible = en[0].isIntersecting;
            if (visible && !raf) loop();
        }).observe(card);
        show(0);
    });

    /* ---- Journey: the step in view sets the stage ---------------------------- */
    $$('[data-journey]').forEach(function (j) {
        var stage = j.querySelector('.stage'), steps = $$('.step', j), cap = j.querySelector('.stage-cap');
        if (!stage || !('IntersectionObserver' in window)) { steps.forEach(function (s) { s.classList.add('is-on'); }); return; }
        var io = new IntersectionObserver(function (en) {
            en.forEach(function (e) {
                if (!e.isIntersecting) return;
                var n = e.target.getAttribute('data-n');
                steps.forEach(function (s) { s.classList.toggle('is-on', s === e.target); });
                stage.setAttribute('data-stage', n);
                if (cap) cap.textContent = e.target.getAttribute('data-cap') || '';
            });
        }, { rootMargin: '-45% 0px -45% 0px' });
        steps.forEach(function (s) { io.observe(s); });
    });

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
