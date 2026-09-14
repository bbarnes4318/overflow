/* NetEnroll public site. Progressive: every page reads and every link works
   with this file absent. It adds the menu toggle, scroll reveals, the mobile
   sticky CTA, the recruiting inquiry form's step flow, and a small event hook
   for analytics. No framework. */
(function () {
    'use strict';

    /* ---- Analytics hook --------------------------------------------------
       No provider is configured, so events go to window.dataLayer (what GTM
       and GA4 read) and a DOM event. Wiring a provider is one snippet in the
       <head>; nothing here changes. */
    window.dataLayer = window.dataLayer || [];
    function track(event, props) {
        var payload = Object.assign({ event: event, page: location.pathname }, props || {});
        window.dataLayer.push(payload);
        document.dispatchEvent(new CustomEvent('ne:track', { detail: payload }));
    }
    window.NE = { track: track };

    document.addEventListener('click', function (e) {
        var el = e.target.closest('[data-track]');
        if (!el) return;
        track(el.getAttribute('data-track'), {
            location: el.getAttribute('data-loc') || '',
            label: el.getAttribute('data-label') || el.textContent.trim().slice(0, 60),
            href: el.getAttribute('href') || ''
        });
    });

    /* ---- Mobile menu ------------------------------------------------------ */
    var menuBtn = document.querySelector('.menu-btn');
    var mobileNav = document.getElementById('mobile-nav');
    if (menuBtn && mobileNav) {
        menuBtn.addEventListener('click', function () {
            var open = menuBtn.getAttribute('aria-expanded') === 'true';
            menuBtn.setAttribute('aria-expanded', String(!open));
            mobileNav.hidden = open;
        });
        mobileNav.addEventListener('click', function (e) {
            if (e.target.closest('a')) { menuBtn.setAttribute('aria-expanded', 'false'); mobileNav.hidden = true; }
        });
    }

    /* ---- Reveal on scroll ------------------------------------------------- */
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var reveals = document.querySelectorAll('.reveal');
    if (reduced || !('IntersectionObserver' in window)) {
        reveals.forEach(function (el) { el.classList.add('is-in'); });
    } else {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (en) {
                if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
            });
        }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
        reveals.forEach(function (el) { io.observe(el); });
    }

    /* ---- Mobile sticky CTA: on once the hero has scrolled past, off while
           the destination section is on screen. --------------------------- */
    var sticky = document.querySelector('.sticky-cta');
    if (sticky && 'IntersectionObserver' in window) {
        var after = document.querySelector(sticky.getAttribute('data-sticky-after') || '#top');
        var untilSel = sticky.getAttribute('data-sticky-until');
        var until = untilSel ? document.querySelector(untilSel) : null;
        var heroGone = false, targetSeen = false;
        var link = sticky.querySelector('a');
        function paint() {
            var on = heroGone && !targetSeen;
            sticky.classList.toggle('is-on', on);
            sticky.setAttribute('aria-hidden', String(!on));
            if (link) link.tabIndex = on ? 0 : -1;
            document.body.classList.toggle('has-sticky', on);
        }
        if (after) new IntersectionObserver(function (en) { heroGone = !en[0].isIntersecting && en[0].boundingClientRect.bottom < 0; paint(); }).observe(after);
        if (until) new IntersectionObserver(function (en) { targetSeen = en[0].isIntersecting; paint(); }, { threshold: 0.1 }).observe(until);
    }

    /* ---- Season notice (recruiting page) --------------------------------- */
    var season = document.getElementById('season');
    if (season) {
        var now = new Date();
        var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var y = today.getFullYear();
        // Open enrollment: Nov 1 through Jan 15; Dec 15 is the deadline for
        // Jan 1 coverage. Computed from the current year so it never goes stale.
        var oepStart = new Date(y, 10, 1), dec15 = new Date(y, 11, 15), oepEnd = new Date(y + 1, 0, 15);
        if (today.getMonth() === 0 && today <= new Date(y, 0, 15)) { oepStart = new Date(y - 1, 10, 1); dec15 = new Date(y - 1, 11, 15); oepEnd = new Date(y, 0, 15); }
        var days = function (d) { var n = Math.round((d - today) / 864e5); return n === 1 ? '1 day' : n + ' days'; };
        var msg;
        if (today < oepStart) msg = 'Open Enrollment begins in ' + days(oepStart) + '. Fund now, recruit before it starts.';
        else if (today <= dec15) msg = 'Open Enrollment is under way. ' + days(dec15) + ' to the December 15 deadline.';
        else if (today <= oepEnd) msg = days(oepEnd) + ' left in Open Enrollment. Special enrollment runs year-round.';
        else msg = 'Recruiting runs year-round. Campaigns start the day they are funded.';
        season.textContent = msg;
    }

    /* ---- Recruiting inquiry form ------------------------------------------
       Three steps, every field kept mounted so nothing typed is lost moving
       back and forth. Validation reads the field's own HTML5 constraints. */
    var form = document.getElementById('inquiry-form');
    if (!form) return;

    var steps = Array.prototype.slice.call(form.querySelectorAll('[data-step]'));
    var bars = form.querySelectorAll('.progress span');
    var labels = form.querySelectorAll('[data-step-label]');
    var progress = form.querySelector('.progress');
    var errorBox = document.getElementById('form-error');
    var success = document.getElementById('form-success');
    var current = 1, started = false;

    function fieldWrap(el) { return el.closest('.field'); }
    function message(el) {
        if (el.validity.valueMissing) return el.tagName === 'SELECT' ? 'Choose one to continue.' : 'This one is required.';
        if (el.validity.typeMismatch && el.type === 'email') return 'That email address does not look complete.';
        if (el.validity.customError) return el.validationMessage;
        return el.validationMessage || 'Please check this field.';
    }
    function validate(el) {
        if (!el.name || el.type === 'button' || el.type === 'submit') return true;
        el.setCustomValidity('');
        if (el.name === 'phone' && el.value && el.value.replace(/\D/g, '').length < 10) el.setCustomValidity('A phone number needs at least ten digits.');
        var ok = el.checkValidity();
        var wrap = fieldWrap(el), err = document.getElementById(el.id + '-err');
        if (wrap) wrap.classList.toggle('is-invalid', !ok);
        el.setAttribute('aria-invalid', String(!ok));
        if (err) { err.textContent = ok ? '' : message(el); if (ok) el.removeAttribute('aria-describedby'); else el.setAttribute('aria-describedby', err.id); }
        return ok;
    }
    function stepFields(n) {
        return Array.prototype.slice.call(steps[n - 1].querySelectorAll('input, select, textarea'));
    }
    function validateStep(n) {
        var bad = stepFields(n).filter(function (el) { return !validate(el); });
        if (bad.length) { bad[0].focus(); return false; }
        return true;
    }
    function show(n) {
        current = n;
        steps.forEach(function (s, i) { s.hidden = (i + 1) !== n; });
        bars.forEach(function (b, i) { b.classList.toggle('is-done', i < n); });
        labels.forEach(function (l, i) { l.classList.toggle('cur', i + 1 === n); });
        if (progress) progress.setAttribute('aria-valuenow', String(n));
        var first = stepFields(n)[0];
        if (first) first.focus({ preventScroll: true });
        var top = form.getBoundingClientRect().top;
        if (top < 0) form.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
        track('recruiting_form_step', { step: n });
    }

    form.addEventListener('focusin', function () {
        if (!started) { started = true; track('recruiting_form_start'); }
    });
    form.addEventListener('blur', function (e) {
        if (e.target.matches('input, select, textarea') && (e.target.value || e.target.getAttribute('aria-invalid') === 'true')) validate(e.target);
    }, true);
    form.addEventListener('change', function (e) {
        if (e.target.matches('select')) validate(e.target);
    });
    form.addEventListener('click', function (e) {
        if (e.target.closest('[data-next]')) { if (validateStep(current)) show(current + 1); }
        else if (e.target.closest('[data-back]')) show(current - 1);
    });
    // Enter on a step-1/2 field advances instead of submitting the hidden form.
    form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && current < steps.length && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
            e.preventDefault();
            if (validateStep(current)) show(current + 1);
        }
    });

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        for (var i = 1; i <= steps.length; i++) {
            if (!validateStep(i)) { if (i !== current) show(i); return; }
        }
        var btn = form.querySelector('[data-submit]');
        var body = Object.fromEntries(new FormData(form));
        body.source = form.getAttribute('data-source') || 'aca-agent-recruiting';
        errorBox.classList.remove('is-on'); errorBox.textContent = '';
        btn.disabled = true; btn.textContent = 'Sending…';
        track('recruiting_form_complete', { agent_count: body.agent_count, timing: body.timing });

        fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (data) {
                    if (!res.ok) throw new Error(data.error || 'The request could not be sent.');
                    return data;
                });
            })
            .then(function (data) {
                form.hidden = true;
                success.hidden = false;
                success.focus && success.setAttribute('tabindex', '-1');
                success.focus();
                track('recruiting_form_success', { id: data.id || null });
            })
            .catch(function (err) {
                errorBox.textContent = (err.message || 'The request could not be sent.') + ' Your answers are still here. Try again, or call 904-512-8487.';
                errorBox.classList.add('is-on');
                track('recruiting_form_error', { message: err.message || '' });
            })
            .then(function () { btn.disabled = false; btn.textContent = "See if we're a fit"; });
    });
})();
