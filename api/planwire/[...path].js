export default async function handler(req, res) {
  const upstreamPath = req.url.replace('/api/planwire', '');
  const url = `https://api.planwire.io${upstreamPath}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Accept': 'application/json',
        'X-API-Key': process.env.PLANWIRE_API_KEY
      }
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
    return;
  }

  const body = await upstream.text();
  res.status(upstream.status)
    .setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
    .setHeader('Access-Control-Allow-Origin', '*')
    .end(body);
}
