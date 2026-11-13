/* NetEnroll homepage only. Loaded after site.js and signal.js.
   1. The hero call timer: one run showing the 120-second billing buffer.
   2. The cost-per-application calculator.
   3. Program buttons preselect their program in the contact form.
   The page reads and every link works without this file. */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };
    var money = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };

    /* ---- 1. Hero call timer --------------------------------------------------- */
    var ring = $('ring');
    if (ring) {
        var time = $('ring-time'), fill = $('ring-fill'), what = $('ring-what'), cost = $('ring-cost');
        var SCALE = 180, END = 146, BUFFER = 120, RUN_MS = 7000;
        var paint = function (sec) {
            var s = Math.floor(sec);
            time.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
            fill.style.width = Math.min(100, (sec / SCALE) * 100) + '%';
            var billable = sec >= BUFFER;
            ring.classList.toggle('is-billable', billable);
            what.textContent = billable ? 'Past 2:00. Billable call.' : 'Under 2:00. You pay nothing.';
            cost.textContent = billable ? '$39' : '$0';
        };
        var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) paint(END);
        else {
            paint(0);
            setTimeout(function () {
                var t0 = null;
                var step = function (now) {
                    if (t0 === null) t0 = now;
                    var p = Math.min(1, (now - t0) / RUN_MS);
                    paint(p * END);
                    if (p < 1) requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            }, 900);
        }
    }

    /* ---- 2. Calculator -------------------------------------------------------- */
    var calc = $('calc');
    if (calc) {
        var n = $('c-n'), day = $('c-day');
        var run = function () {
            var price = Number(calc.querySelector('input[name="cprog"]:checked').value);
            var calls = Number(n.value), perDay = Number(day.value);
            $('o-n').textContent = calls;
            $('o-day').textContent = perDay;
            $('o-cpa').textContent = money(price * calls);
            var apps = perDay / calls;
            $('o-apps').textContent = apps >= 10 ? Math.round(apps) : (Math.round(apps * 10) / 10);
            $('o-spend').textContent = money(price * perDay);
            $('o-rate').textContent = money(price);
        };
        calc.addEventListener('input', run);
        calc.addEventListener('change', run);
        run();
    }

    /* ---- 3. Program buttons preselect the form -------------------------------- */
    document.addEventListener('click', function (e) {
        var a = e.target.closest('[data-product]');
        if (!a) return;
        var want = a.getAttribute('data-product');
        Array.prototype.forEach.call(document.querySelectorAll('#lead-form input[name="products"]'), function (c) {
            c.checked = want === 'both' || c.value === want;
        });
    }, true);
})();
