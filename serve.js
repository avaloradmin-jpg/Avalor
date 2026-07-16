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

const RESEND_API_KEY = ENV.RESEND_API_KEY || '';

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

// Reconstruct the upstream path from a ?path= query param (mirrors api/homedata.js and api/planwire.js)
function upstreamPathFromQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  const subPath = (url.searchParams.get('path') || '').replace(/^\/+/, '');
  url.searchParams.delete('path');
  const qs = url.searchParams.toString();
  return '/' + subPath + (qs ? '?' + qs : '');
}

function proxyHomedata(req, res) {
  proxyRequest(req, res, HOMEDATA_BASE, upstreamPathFromQuery(req), { 'Authorization': `Api-Key ${HOMEDATA_KEY}` });
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

// Never add user_id, id, or share_token here — this list is returned to anonymous visitors.
const SHARED_DEAL_PUBLIC_FIELDS = [
  'postcode', 'name', 'dev_type', 'prop_type', 'region',
  'purchase', 'floor_area', 'units', 'gdv', 'build_cost', 'sdlt',
  'finance', 'profit', 'margin', 'rlv', 'growth_rate', 'verdict',
  'appraisal_data', 'created_at'
];

// Look up a shared deal by token using the service-role key (mirrors api/shared-deal.js)
async function fetchSharedDeal(token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/saved_deals?share_token=eq.${encodeURIComponent(token)}&share_enabled=eq.true&select=${SHARED_DEAL_PUBLIC_FIELDS.join(',')}`,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Accept': 'application/json'
      },
    };
    https.get(options, upstream => {
      let body = '';
      upstream.on('data', c => { body += c; });
      upstream.on('end', () => {
        try { resolve({ status: upstream.statusCode, data: JSON.parse(body) }); }
        catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

// Build the "deal saved" email subject/body (mirrors api/send-email.js)
const money = n => '£' + Math.round(n).toLocaleString('en-GB');

function buildDealSavedEmail({ postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore }) {
  const subject = `Deal saved: ${postcode} — ${devType}`;
  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto">
      <h2 style="margin-bottom:4px">${postcode} — ${devType}</h2>
      <p style="color:#555;margin-top:0">Your appraisal has been saved to your Avalor pipeline.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px 0;color:#555">GDV</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(gdv)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Total build cost</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(buildCost)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Profit</td><td style="padding:6px 0;text-align:right;font-weight:600">${money(profit)}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Margin</td><td style="padding:6px 0;text-align:right;font-weight:600">${margin}%</td></tr>
        <tr><td style="padding:6px 0;color:#555">Verdict</td><td style="padding:6px 0;text-align:right;font-weight:600">${verdict}</td></tr>
        <tr><td style="padding:6px 0;color:#555">Avalor Score</td><td style="padding:6px 0;text-align:right;font-weight:600">${avalorScore}/100</td></tr>
      </table>
      <p><a href="https://avalor.co.uk" style="color:#1a7f37;font-weight:600;text-decoration:none">View your deals on Avalor →</a></p>
    </div>`;
  return { subject, html };
}

// Send an email via the Resend API using the account's API key
function sendViaResend({ to, subject, html }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from: 'noreply@avalor.co.uk', to: [to], subject, html });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Resend responded ${res.statusCode}: ${data}`));
      });
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

  // ── Send "deal saved" email via Resend ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/send-email') {
    try {
      const buf = await readBody(req);
      const { postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore, toEmail } = JSON.parse(buf.toString());

      if (!toEmail) return jsonResponse(res, 400, { error: 'Missing toEmail' });

      const { subject, html } = buildDealSavedEmail({ postcode, devType, gdv, buildCost, profit, margin, verdict, avalorScore });
      await sendViaResend({ to: toEmail, subject, html });

      return jsonResponse(res, 200, { sent: true });
    } catch (err) {
      console.error('Send email error:', err.message);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── Existing proxy routes ───────────────────────────────────────────────────
  if (req.url.startsWith('/api/homedata')) {
    return proxyHomedata(req, res);
  }
  if (req.url.startsWith('/api/planwire')) {
    return proxyRequest(req, res, PLANWIRE_BASE, upstreamPathFromQuery(req), { 'X-API-Key': PLANWIRE_KEY });
  }

  // ── Public shared-deal lookup (mirrors api/shared-deal.js) ──────────────────
  if (req.url.startsWith('/api/shared-deal')) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (!token) return jsonResponse(res, 400, { error: 'Missing token' });
    try {
      const { status, data } = await fetchSharedDeal(token);
      if (status !== 200 || !Array.isArray(data) || data.length === 0) {
        return jsonResponse(res, 404, { error: 'This share link is invalid or has been disabled' });
      }
      return jsonResponse(res, 200, data[0]);
    } catch (err) {
      return jsonResponse(res, 502, { error: err.message });
    }
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
