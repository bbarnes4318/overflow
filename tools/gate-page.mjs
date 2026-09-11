// Wrap a static HTML page in a password gate.
//
//   node tools/gate-page.mjs <source.html> <output.html>
//
// The password comes from GATE_PASSWORD in the environment (or --password=...
// on the command line). It is never written anywhere: not into the output, not
// into git. Lose it and the page has to be rebuilt with a new one.
//
// Why this and not nginx auth_basic: deploy.sh installs the vhost once and then
// leaves it alone so certbot's TLS edits survive, which means any location block
// added here is a manual server change (see the eb375c3 commit message). An
// encrypted page needs no server support at all - it is one more static file
// that try_files serves at /<name> like the legal pages. It also prompts for a
// password only, where basic auth would demand a username too.
//
// The page body is AES-256-GCM encrypted with a key derived from the password by
// PBKDF2-SHA256 (600k iterations, random salt). The output is a small unlock
// page carrying the ciphertext; the browser derives the key with WebCrypto and
// writes the decrypted document in place. Viewing the source shows nothing but
// the blob. This is the StatiCrypt model, done here in ~100 lines so there is
// no dependency and nothing to install on the server.

import { readFile, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const getRandomValues = arr => webcrypto.getRandomValues(arr);
const ITERATIONS = 600_000;

const args = process.argv.slice(2);
const pwArg = args.find(a => a.startsWith('--password='));
const [src, out] = args.filter(a => !a.startsWith('--'));
const password = pwArg ? pwArg.slice('--password='.length) : process.env.GATE_PASSWORD;

if (!src || !out || !password) {
  console.error('usage: GATE_PASSWORD=... node tools/gate-page.mjs <source.html> <output.html>');
  process.exit(2);
}

const b64 = bytes => Buffer.from(bytes).toString('base64');

const salt = getRandomValues(new Uint8Array(16));
const iv = getRandomValues(new Uint8Array(12));
const baseKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey(
  { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
  baseKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt']);
const plain = await readFile(src);
const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));

const payload = JSON.stringify({ v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) });

// The <title> is the one thing taken from the source, so the tab reads right
// before and after unlocking.
const title = (plain.toString('utf8').match(/<title>([^<]*)<\/title>/i) || [, 'NetEnroll'])[1];

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  [hidden]{display:none!important}
  html,body{height:100%}
  body{background:#EDF1F5;color:#1A2230;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;
    font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased;display:grid;place-items:center;padding:24px}
  .gate{width:100%;max-width:380px;background:#fff;border:1px solid #DCE2EA;border-radius:14px;
    padding:28px 26px 24px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px -16px rgba(16,24,40,.18)}
  .gate img{height:26px;width:auto;display:block;margin-bottom:18px}
  h1{font-size:17px;font-weight:600;letter-spacing:-.01em;margin-bottom:4px}
  p{color:#4B5563;font-size:13px;margin-bottom:18px}
  label{display:block;font-size:12px;font-weight:500;color:#4B5563;margin-bottom:6px}
  input[type=password]{width:100%;font:inherit;font-size:15px;padding:10px 12px;border:1.5px solid #C2CBD7;border-radius:8px;
    color:#1A2230;background:#fff;outline:0}
  input[type=password]:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,.18)}
  .err{color:#B91C1C;font-size:12.5px;min-height:18px;margin-top:8px}
  .remember{display:flex;align-items:center;gap:8px;font-size:12.5px;color:#4B5563;margin:8px 0 16px;cursor:pointer}
  .remember input{width:15px;height:15px;accent-color:#047857}
  button{width:100%;font:inherit;font-size:14px;font-weight:600;padding:11px 14px;border:0;border-radius:8px;
    background:#10B981;color:#04261B;cursor:pointer}
  button:hover{background:#0ea371}
  button[disabled]{opacity:.6;cursor:default}
</style>
</head>
<body>
<form class="gate" id="gate" autocomplete="off" hidden>
  <img src="/netenroll-logo.png" alt="NetEnroll">
  <h1>This page is password protected</h1>
  <p>Enter the password you were given to open it.</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" autocomplete="current-password" autofocus required>
  <div class="err" id="err" role="alert"></div>
  <label class="remember"><input type="checkbox" id="remember"> Remember on this device</label>
  <button type="submit" id="go">Open</button>
</form>
<script type="application/json" id="payload">${payload}</script>
<script>
(async () => {
  const P = JSON.parse(document.getElementById('payload').textContent);
  const un = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const salt = un(P.salt), iv = un(P.iv), ct = un(P.ct);
  // A different salt means a different password, so a key remembered for the
  // old one is simply never found.
  const STORE = 'netenroll.gate.' + P.salt.slice(0, 12);

  const open = async (key) => {
    const html = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
    document.open(); document.write(html); document.close();
  };
  const loadKey = async (raw) => crypto.subtle.importKey('raw', un(raw), 'AES-GCM', false, ['decrypt']);

  // document.open() is a no-op while the parser is still running, in which
  // case document.write() would splice the model INTO this page instead of
  // replacing it. So nothing is written until parsing is done.
  if (document.readyState === 'loading') {
    await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  }

  // Already unlocked in this tab (or on this device)?
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(STORE);
      if (raw) { await open(await loadKey(raw)); return; }
    } catch (e) { try { store.removeItem(STORE); } catch (_) {} }
  }

  const form = document.getElementById('gate'), pw = document.getElementById('pw'),
        err = document.getElementById('err'), go = document.getElementById('go');
  form.hidden = false; pw.focus();
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.textContent = ''; go.disabled = true; go.textContent = 'Checking…';
    try {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw.value), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: P.iter },
        base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
      const raw = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', key))));
      // Decrypt before remembering, so a wrong password is never stored.
      const html = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
      try { (document.getElementById('remember').checked ? localStorage : sessionStorage).setItem(STORE, raw); } catch (_) {}
      document.open(); document.write(html); document.close();
    } catch (e) {
      err.textContent = 'That password didn\\u2019t work. Check it and try again.';
      go.disabled = false; go.textContent = 'Open'; pw.select();
    }
  });
})();
</script>
</body>
</html>
`;

await writeFile(out, page);
console.log(`gated ${src} -> ${out} (${plain.length} bytes in, ${page.length} bytes out)`);
