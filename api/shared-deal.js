const https = require('https');
const { URL } = require('url');

const SUPABASE_HOSTNAME = 'jjegxgveeowrrgnfvaxn.supabase.co';

// Never add user_id, id, or share_token here — this list is returned to anonymous visitors.
const PUBLIC_FIELDS = [
  'postcode', 'name', 'dev_type', 'prop_type', 'region',
  'purchase', 'floor_area', 'units', 'gdv', 'build_cost', 'sdlt',
  'finance', 'profit', 'margin', 'rlv', 'growth_rate', 'verdict',
  'appraisal_data', 'created_at'
];

function supabaseGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_HOSTNAME,
      path,
      method: 'GET',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json'
      }
    };
    https.get(options, upstream => {
      let body = '';
      upstream.on('data', chunk => { body += chunk; });
      upstream.on('end', () => {
        try {
          resolve({ status: upstream.statusCode, data: JSON.parse(body) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Missing token' }));
  }

  try {
    const path = `/rest/v1/saved_deals?share_token=eq.${encodeURIComponent(token)}&share_enabled=eq.true&select=${PUBLIC_FIELDS.join(',')}`;
    const { status, data } = await supabaseGet(path);

    if (status !== 200 || !Array.isArray(data) || data.length === 0) {
      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'This share link is invalid or has been disabled' }));
    }

    res.writeHead(200);
    res.end(JSON.stringify(data[0]));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
};
