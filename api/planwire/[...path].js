const https = require('https');

module.exports = function handler(req, res) {
  // Strip the function's own route prefix from the raw request URL
  const upstreamPath = req.url.replace(/^\/api\/planwire/, '') || '/';

  const options = {
    hostname: 'api.planwire.io',
    path: upstreamPath,
    method: req.method,
    headers: {
      'Accept': 'application/json',
      'X-API-Key': process.env.PLANWIRE_API_KEY
    }
  };

  const proxy = https.request(options, upstream => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/json');
    res.writeHead(upstream.statusCode);
    upstream.pipe(res);
  });

  proxy.on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });

  req.pipe(proxy);
};
