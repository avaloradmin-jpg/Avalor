const https = require('https');

const SUPABASE_HOSTNAME = 'jjegxgveeowrrgnfvaxn.supabase.co';

// Public anon/publishable key — matches js/supabase.js. Safe to embed; it only
// ever grants what RLS allows, which is exactly why we use it here instead of
// the service key: paired with the caller's own access token, Supabase's
// "Users can view own profile" policy guarantees this can only ever return
// the caller's own row, so there's no way to pass someone else's userId and
// open their billing portal.
const SUPABASE_ANON_KEY = 'sb_publishable_WWzB1IuUp8jYWZ10Mf2-xA_R_4ai4xI';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Fetches the caller's own profile using their access token, not the service
// key — Supabase RLS restricts the result to auth.uid() = id regardless of
// what the client asks for.
function fetchOwnStripeCustomerId(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_HOSTNAME,
      path: '/rest/v1/profiles?select=stripe_customer_id',
      method: 'GET',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    };
    https.get(options, upstream => {
      let body = '';
      upstream.on('data', c => { body += c; });
      upstream.on('end', () => {
        try {
          const rows = JSON.parse(body);
          resolve(rows[0] && rows[0].stripe_customer_id ? rows[0].stripe_customer_id : null);
        } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(JSON.stringify({ error: 'Method not allowed' })); }

  const authHeader = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!accessToken) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: 'Missing access token' }));
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    await readBody(req); // drain body, unused

    const customerId = await fetchOwnStripeCustomerId(accessToken);

    if (!customerId) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'No active subscription found for this account' }));
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: 'https://avalor.co.uk/?portal_return=1',
    });

    res.writeHead(200);
    res.end(JSON.stringify({ url: session.url }));
  } catch (err) {
    console.error('Portal session error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
};
