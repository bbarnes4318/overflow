// Static checks for the public site. Fails when the recruiting form and the
// API disagree - the bug that silently rejected every inquiry in production -
// and when a page ships without the SEO head every route must carry.
//
//   node tools/check-site.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const server = read('messaging/server.js');
const aca = read('aca-agent-recruiting.html');
const pages = { 'index.html': read('index.html'), 'aca-agent-recruiting.html': aca, 'licensing-value.html': read('licensing-value.html'),
                'apps/agency-planner/index.html': read('apps/agency-planner/index.html') };

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

console.log(`ok: ${required.length} required fields present, ${Object.keys(serverOptions).length} option lists match, ${Object.keys(pages).length} pages carry SEO head`);
