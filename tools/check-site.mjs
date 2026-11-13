// Static checks for the public site. Fails when the recruiting form and the
// API disagree - the bug that silently rejected every inquiry in production -
// and when a page ships without the SEO head every route must carry.
//
//   node tools/check-site.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const server = read('messaging/server.js');
const aca = read('aca-agent-recruiting.html');
const pages = { 'index.html': read('index.html'), 'aca-agent-recruiting.html': aca, 'licensing-value.html': read('licensing-value.html'),
                'apps/agency-planner/index.html': read('apps/agency-planner/index.html'), 'a2p-registration.html': read('a2p-registration.html'),
                'medicare-tv-calls.html': read('medicare-tv-calls.html'), 'final-expense-tv-calls.html': read('final-expense-tv-calls.html') };

// 1. Every field the server requires is a named control in the form, and
//    every <select> offers exactly the server's allowed values.
const required = [...server.match(/for \(const key of \[([^\]]+)\]\)/)[1].matchAll(/'(\w+)'/g)].map(m => m[1]);
for (const key of required) assert.match(aca, new RegExp(`name="${key}"`), `form is missing required field "${key}"`);

const optionsSrc = server.match(/const INQUIRY_OPTIONS = \{([\s\S]*?)\n\};/)[1];
const serverOptions = Object.fromEntries([...optionsSrc.matchAll(/(\w+): \[([^\]]+)\]/g)]
    .map(([, k, v]) => [k, [...v.matchAll(/'([^']+)'/g)].map(m => m[1])]));
for (const [name, allowed] of Object.entries(serverOptions)) {
    const sel = aca.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(sel, `no <select name="${name}"> in the form`);
    const offered = [...sel[1].matchAll(/<option(?![^>]*value="")[^>]*>([^<]+)<\/option>/g)].map(m => m[1].trim());
    assert.deepEqual(offered, allowed, `options for "${name}" differ from the server's INQUIRY_OPTIONS`);
}
assert.match(aca, /action="\/api\/recruiting-inquiry"/, 'form must post to the API path nginx proxies');

// 2. Server-delivered SEO head on every route.
for (const [file, html] of Object.entries(pages)) {
    for (const re of [/<title>[^<]{10,}<\/title>/, /<meta name="description" content="[^"]{40,}"/, /<link rel="canonical" href="https:\/\/netenroll\.com\/[^"]*">/,
                      /<meta property="og:title"/, /<meta property="og:image"/, /<link rel="icon"/]) {
        assert.match(html, re, `${file}: missing ${re}`);
    }
}
// 2b. Every page with the shared header links the Agency Planner.
for (const file of ['index.html', 'aca-agent-recruiting.html', 'licensing-value.html']) {
    assert.match(pages[file], /<a href="\/agency-planner">Agency Planner<\/a>/, `${file}: header is missing the Agency Planner link`);
}
for (const file of ['index.html', 'aca-agent-recruiting.html']) {
    assert.match(pages[file], /<li><a href="https:\/\/netenroll\.com\/agency-planner">Agency planner<\/a><\/li>/, `${file}: footer is missing the Agency planner link`);
}

// 3. Nothing from the deleted prototype leaks through: no fake portal, no
//    mock data, no in-browser JSX on the two marketing pages.
for (const file of ['index.html', 'aca-agent-recruiting.html']) {
    for (const bad of ['Marcus Vance', 'babel', 'cdn.tailwindcss.com', 'unpkg.com/react', 'onboardingStep', 'Simulate Call']) {
        assert.ok(!pages[file].toLowerCase().includes(bad.toLowerCase()), `${file} still contains "${bad}"`);
    }
}
// 4. The ACA page never routes a visitor into the Final Expense signup.
assert.ok(!/href="https:\/\/agents\.netenroll\.com"[^>]*>(Get started|Start Receiving)/.test(aca), 'ACA page must not carry the Final Expense signup CTA');

// 5. The A2P form offers exactly the server's choices, posts to the proxied
//    path, and is published by the deploy.
const { A2P_OPTIONS, A2P_MULTI } = createRequire(import.meta.url)('../messaging/a2p.js');
const a2pPage = pages['a2p-registration.html'];
for (const [name, allowed] of Object.entries({ ...A2P_OPTIONS, ...A2P_MULTI })) {
    const sel = a2pPage.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
    const offered = sel
        ? [...sel[1].matchAll(/<option>([^<]+)<\/option>/g)].map(m => m[1])
        : [...a2pPage.matchAll(new RegExp(`<input type="(?:radio|checkbox)" name="${name}" value="([^"]+)"`, 'g'))].map(m => m[1]);
    assert.deepEqual(offered, allowed, `a2p-registration.html: choices for "${name}" differ from messaging/a2p.js`);
}
assert.ok(a2pPage.includes('action="/api/a2p-registration"'), 'A2P form must post to the API path nginx proxies');
assert.ok(read('deploy.sh').includes('a2p-registration.html'), 'deploy.sh must publish a2p-registration.html');

// 6. TV inbound calls: one price per product everywhere, the CPA rates
//    untouched, partner stats only on Medicare, and the shared form agrees
//    with the server and is published by the deploy.
const home = pages['index.html'], med = pages['medicare-tv-calls.html'], fe = pages['final-expense-tv-calls.html'];
for (const [file, html] of Object.entries({ 'index.html': home, 'medicare-tv-calls.html': med, 'final-expense-tv-calls.html': fe })) {
    assert.match(html, /120-second/, `${file}: missing the 120-second buffer`);
    assert.ok(!/\$(3[0-8]|4[0-3]|4[5-9])\b/.test(html.replace(/\$39|\$44/g, '')), `${file}: a TV call price other than $39/$44 appears`);
    assert.match(html, /action="\/api\/tv-calls-inquiry"/, `${file}: lead form must post to the proxied API path`);
}
for (const r of ['$199', '$159', '$100']) assert.ok(home.includes(r), `index.html: pay-per-application rate ${r} is missing`);
assert.ok(med.includes('<span class="amt">39</span>') && !med.includes('<span class="amt">44</span>'), 'Medicare page must show $39 only');
assert.ok(fe.includes('<span class="amt">44</span>') && !fe.includes('<span class="amt">39</span>'), 'Final Expense page must show $44 only');
assert.ok(!/Denver|~200|1 in 3/i.test(fe), 'Medicare partner statistics must not appear on the Final Expense page');
assert.match(med, /not guaranteed/, 'Medicare partner statistics need the not-guaranteed qualifier');
assert.match(med, /value="medicare" checked/, 'Medicare page must preselect Medicare');
assert.match(fe, /value="final_expense" checked/, 'Final Expense page must preselect Final Expense');
const tvSrc = server.match(/const TV_CALL_OPTIONS = \{([\s\S]*?)\n\};/)[1];
const tvOpts = Object.fromEntries([...tvSrc.matchAll(/(\w+): \[([^\]]+)\]/g)].map(([, k, v]) => [k, [...v.matchAll(/'([^']+)'/g)].map(m => m[1])]));
for (const html of [home, med, fe]) {
    assert.deepEqual([...html.matchAll(/name="products" value="(\w+)"/g)].map(m => m[1]), tvOpts.products, 'product checkboxes differ from TV_CALL_OPTIONS');
    for (const name of ['agent_type', 'agent_count']) {
        const sel = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
        assert.deepEqual([...sel[1].matchAll(/<option>([^<]+)<\/option>/g)].map(m => m[1]), tvOpts[name], `"${name}" options differ from TV_CALL_OPTIONS`);
    }
}
const deploySh = read('deploy.sh');
for (const f of ['medicare-tv-calls.html', 'final-expense-tv-calls.html', 'signal.css', 'signal.js', 'og-medicare-tv.png', 'og-final-expense-tv.png'])
    assert.ok(deploySh.includes(f), `deploy.sh must publish ${f}`);
assert.ok(deploySh.includes("splice_location 'location = /api/tv-calls-inquiry {'"), 'deploy.sh must splice the TV form proxy');

console.log(`ok: ${required.length} required fields present, ${Object.keys(serverOptions).length} option lists match, ${Object.keys(pages).length} pages carry SEO head`);
