const https = require('https');
const { URL } = require('url');

module.exports = function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const subPath = (url.searchParams.get('path') || '').replace(/^\/+/, '');
  url.searchParams.delete('path');
  const qs = url.searchParams.toString();
  const upstreamPath = '/' + subPath + (qs ? '?' + qs : '');

  const options = {
    hostname: 'api.get-energy-performance-data.communities.gov.uk',
    path: upstreamPath,
    method: req.method,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${process.env.EPC_API_TOKEN}`
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
