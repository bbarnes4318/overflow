// Local stand-in for the nginx vhost: serves the single HTML file as
// index.html, publishes licensing-fees.json beside it, and falls back to
// index.html for unknown paths -- the same try_files behaviour the real
// site relies on for /licensing-value.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || process.cwd();
const PORT = Number(process.env.PORT || 4173);

const MAP = {
  '/': { file: 'netenroll_platform_app.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'netenroll_platform_app.html', type: 'text/html; charset=utf-8' },
  '/licensing-fees.json': { file: 'src/data/licensing-fees.json', type: 'application/json; charset=utf-8' },
  '/sitemap.xml': { file: 'sitemap.xml', type: 'application/xml; charset=utf-8' },
  '/robots.txt': { file: 'robots.txt', type: 'text/plain; charset=utf-8' },
  '/netenroll-logo.png': { file: 'netenroll-logo.png', type: 'image/png' },
  '/netenroll-logo-dark.png': { file: 'netenroll-logo-dark.png', type: 'image/png' },
  // Password-gated page: nginx serves the encrypted file at /cpa-model via $uri.html.
  '/cpa-model': { file: 'protected/cpa-model.html', type: 'text/html; charset=utf-8' },
  '/cpa-model.html': { file: 'protected/cpa-model.html', type: 'text/html; charset=utf-8' }
};

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const hit = MAP[url] || MAP['/'];
  const abs = path.join(ROOT, hit.file);
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('cannot read ' + hit.file + ': ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('serving ' + ROOT + ' on http://localhost:' + PORT));
