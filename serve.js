const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(process.argv[1] || __filename);
const PORT = 3456;

// Parse .env
const ENV = {};
try {
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) ENV[k.trim()] = v.join('=').trim();
  });
} catch (_) {}

const HOMEDATA_KEY = ENV.HOMEDATA_API_KEY || '';
const HOMEDATA_BASE = 'api.homedata.co.uk';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function proxyHomedata(req, res) {
  const upstreamPath = req.url.replace('/api/homedata', '');
  const options = {
    hostname: HOMEDATA_BASE,
    path: upstreamPath,
    method: req.method,
    headers: {
      'Authorization': `Api-Key ${HOMEDATA_KEY}`,
      'Accept': 'application/json'
    }
  };

  const proxy = https.request(options, upstreamRes => {
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    upstreamRes.pipe(res);
  });

  proxy.on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(proxy);
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/homedata/')) {
    return proxyHomedata(req, res);
  }

  let filePath = path.join(ROOT, req.url === '/' ? '/index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => process.stdout.write(`Listening on ${PORT}\n`));
