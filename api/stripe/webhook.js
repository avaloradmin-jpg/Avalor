const https = require('https');

const SUPABASE_HOSTNAME = 'jjegxgveeowrrgnfvaxn.supabase.co';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function patchProfile(filterQs, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(fields);
    const options = {
      hostname: SUPABASE_HOSTNAME,
      path: `/rest/v1/profiles?${filterQs}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey': process.env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
    };
    const req = https.request(options, upstream => {
      upstream.resume();
      upstream.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const patchProfileById = (userId, fields) =>
  patchProfile(`id=eq.${encodeURIComponent(userId)}`, fields);

const patchProfileByCustomerId = (customerId, fields) =>
  patchProfile(`stripe_customer_id=eq.${encodeURIComponent(customerId)}`, fields);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const buf = await readBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    res.writeHead(400);
    return res.end(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const plan = session.metadata && session.metadata.plan;

      if (userId && plan && process.env.SUPABASE_SERVICE_KEY) {
        await patchProfileById(userId, { plan, stripe_customer_id: session.customer });
        console.log(`Plan updated: user=${userId} plan=${plan} customer=${session.customer}`);
      } else if (!process.env.SUPABASE_SERVICE_KEY) {
        console.warn('SUPABASE_SERVICE_KEY not set — skipping profile update');
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      if (customerId && process.env.SUPABASE_SERVICE_KEY) {
        // Subscription has actually ended (the customer kept access through
        // their paid period — this event only fires once Stripe closes it
        // out). Drop them back to trial; trial_started_at is left untouched
        // so this reads as an already-expired trial, not a fresh one.
        await patchProfileByCustomerId(customerId, { plan: 'trial' });
        console.log(`Subscription ended: customer=${customerId} — plan reset to trial`);
      }
    }
  } catch (err) {
    console.error('Supabase update failed:', err.message);
  }

  res.writeHead(200);
  res.end(JSON.stringify({ received: true }));
};

// Stripe signature verification needs the exact raw request bytes — disable
// Vercel's automatic JSON body parsing for this route so readBody() above
// gets the untouched buffer.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
