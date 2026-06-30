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

const PLANWIRE_KEY = ENV.PLANWIRE_API_KEY || '';
const PLANWIRE_BASE = 'api.planwire.io';

const SUPABASE_URL = 'jjegxgveeowrrgnfvaxn.supabase.co';
const SUPABASE_SERVICE_KEY = ENV.SUPABASE_SERVICE_KEY || '';

const stripe = require('stripe')(ENV.STRIPE_SECRET_KEY || '');

const PRICES = {
  essential: ENV.STRIPE_PRICE_ESSENTIAL || '',
  professional: ENV.STRIPE_PRICE_PROFESSIONAL || '',
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff'
};

function proxyRequest(req, res, hostname, upstreamPath, extraHeaders) {
  const options = {
    hostname,
    path: upstreamPath,
    method: req.method,
    headers: { 'Accept': 'application/json', ...extraHeaders }
  };
  const proxy = https.request(options, upstreamRes => {
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    upstreamRes.pipe(res);
  });
  proxy.on('error', err => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); });
  req.pipe(proxy);
}

function proxyHomedata(req, res) {
  const upstreamPath = req.url.replace('/api/homedata', '');
  proxyRequest(req, res, HOMEDATA_BASE, upstreamPath, { 'Authorization': `Api-Key ${HOMEDATA_KEY}` });
}

// Collect raw request body as a Buffer (needed for Stripe webhook signature verification)
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Update a Supabase profile's plan using the service-role key
async function updateSupabasePlan(userId, plan) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ plan });
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal',
      },
    };
    const req = https.request(options, res => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
    return res.end();
  }

  // ── Stripe: create checkout session ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/stripe/create-checkout') {
    try {
      const buf = await readBody(req);
      const { plan, userId, email } = JSON.parse(buf.toString());

      if (!PRICES[plan]) return jsonResponse(res, 400, { error: 'Unknown plan' });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        customer_email: email,
        client_reference_id: userId,
        line_items: [{ price: PRICES[plan], quantity: 1 }],
        metadata: { plan },
        success_url: `http://localhost:${PORT}/?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `http://localhost:${PORT}/?cancelled=1`,
      });

      return jsonResponse(res, 200, { url: session.url });
    } catch (err) {
      console.error('Checkout error:', err.message);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── Stripe: webhook ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/stripe/webhook') {
    const buf = await readBody(req);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(buf, sig, ENV.STRIPE_WEBHOOK_SECRET || '');
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      res.writeHead(400);
      return res.end(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      const plan = session.metadata && session.metadata.plan;

      if (userId && plan && SUPABASE_SERVICE_KEY) {
        try {
          await updateSupabasePlan(userId, plan);
          console.log(`Plan updated: user=${userId} plan=${plan}`);
        } catch (err) {
          console.error('Supabase update failed:', err.message);
        }
      } else if (!SUPABASE_SERVICE_KEY) {
        console.warn('SUPABASE_SERVICE_KEY not set — skipping profile update');
      }
    }

    res.writeHead(200);
    return res.end(JSON.stringify({ received: true }));
  }

  // ── Existing proxy routes ───────────────────────────────────────────────────
  if (req.url.startsWith('/api/homedata/')) {
    return proxyHomedata(req, res);
  }
  if (req.url.startsWith('/api/planwire/')) {
    const upstreamPath = req.url.replace('/api/planwire', '');
    return proxyRequest(req, res, PLANWIRE_BASE, upstreamPath, { 'X-API-Key': PLANWIRE_KEY });
  }

  // ── Static file serving ─────────────────────────────────────────────────────
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => process.stdout.write(`Listening on ${PORT}\n`));
