const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') u = '/index.html';
  const f = path.join(root, u.replace(/^\/+/, ''));
  if (!f.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(f, (e, d) => {
    if (e) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(f);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(d);
  });
}).listen(8080, () => console.log('ready on 8080'));
