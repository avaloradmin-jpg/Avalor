const https = require('https');

const SUPABASE_HOSTNAME = 'jjegxgveeowrrgnfvaxn.supabase.co';

const PRICES = {
  essential: process.env.STRIPE_PRICE_ESSENTIAL || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Look up a previously-saved Stripe customer for this user, so a resubscribe
// after cancelling reuses the same Stripe customer instead of creating a
// duplicate one.
function findStripeCustomerId(userId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_HOSTNAME,
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`,
      method: 'GET',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
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

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  try {
    const buf = await readBody(req);
    const { plan, userId, email } = JSON.parse(buf.toString());

    if (!PRICES[plan]) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Unknown plan' })); }

    const existingCustomerId = userId ? await findStripeCustomerId(userId) : null;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: email }),
      client_reference_id: userId,
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      metadata: { plan },
      success_url: `https://avalor.co.uk/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://avalor.co.uk/?cancelled=1`,
    });

    res.writeHead(200);
    res.end(JSON.stringify({ url: session.url }));
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
};
