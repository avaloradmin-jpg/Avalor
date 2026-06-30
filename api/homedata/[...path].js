export default async function handler(req, res) {
  const upstreamPath = req.url.replace('/api/homedata', '');
  const url = `https://api.homedata.co.uk${upstreamPath}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Api-Key ${process.env.HOMEDATA_API_KEY}`
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
