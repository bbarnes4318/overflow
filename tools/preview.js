// Local stand-in for the nginx vhost. Resolves a request the way
// `try_files $uri $uri.html /index.html` does - a real file first, then the
// same name with .html (so /aca-agent-recruiting and /licensing-value work),
// then index.html - and forwards /api/* to the messaging app (API_PORT,
// default 3100) the way the nginx location block does.
//
//   node tools/preview.js            # http://localhost:4173
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.env.PORT || 4173);
const API_PORT = Number(process.env.API_PORT || 3100);

// Files nginx serves from the web root under a different name than the repo path.
const ALIAS = {
  '/licensing-fees.json': 'src/data/licensing-fees.json',
  '/cpa-model': 'protected/cpa-model.html',
  '/cpa-model.html': 'protected/cpa-model.html',
  '/terms': 'legal/terms.html',
  '/privacy': 'legal/privacy.html',
  '/tcpa-compliance': 'legal/tcpa-compliance.html',
  '/legal.css': 'legal/legal.css'
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function resolve(url) {
  if (ALIAS[url]) return ALIAS[url];
  const rel = url === '/' ? 'index.html' : url.slice(1);
  for (const cand of [rel, rel + '.html']) {
    const abs = path.join(ROOT, cand);
    if (abs.startsWith(ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return cand;
  }
  return 'index.html';
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/')) {
    const up = http.request({ host: '127.0.0.1', port: API_PORT, method: req.method, path: req.url, headers: req.headers },
      r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'messaging app not running: ' + e.message })); });
    req.pipe(up);
    return;
  }
  const file = resolve(url);
  fs.readFile(path.join(ROOT, file), (err, buf) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('cannot read ' + file + ': ' + err.message); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('serving ' + ROOT + ' on http://localhost:' + PORT));
