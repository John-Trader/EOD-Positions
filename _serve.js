const http = require('http');
const fs = require('fs');
const path = require('path');
const root = fs.realpathSync(__dirname);
const publicFiles = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'icon.svg']);
const allowedHosts = new Set(['localhost:8080', '127.0.0.1:8080']);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function isWithinRoot(file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const fail = (status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : message);
  };
  if (!allowedHosts.has((req.headers.host || '').toLowerCase())) return fail(403, 'Forbidden');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return fail(405, 'Method Not Allowed');
  }
  let u;
  try {
    u = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    return fail(400, 'Bad Request');
  }
  if (!u.startsWith('/') || u.startsWith('//') || /[\0\\:]/.test(u)) return fail(403, 'Forbidden');
  if (u === '/') u = '/index.html';
  const file = path.resolve(root, `.${u}`);
  if (!isWithinRoot(file)) return fail(403, 'Forbidden');
  if (!publicFiles.has(path.relative(root, file))) return fail(404, 'Not Found');
  fs.realpath(file, (realError, realFile) => {
    if (realError) return fail(404, 'Not Found');
    if (!isWithinRoot(realFile)) return fail(403, 'Forbidden');
    fs.stat(realFile, (statError, stat) => {
      if (statError || !stat.isFile()) return fail(404, 'Not Found');
      const headers = { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' };
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...headers, 'Content-Length': stat.size });
        return res.end();
      }
      fs.readFile(realFile, (readError, data) => {
        if (readError) return fail(404, 'Not Found');
        res.writeHead(200, { ...headers, 'Content-Length': data.length });
        res.end(data);
      });
    });
  });
}).listen(8080, '127.0.0.1', () => console.log('ready on http://localhost:8080'));
