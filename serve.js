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

const PLANWIRE_KEY = ENV.PLANWIRE_API_KEY || '';
const PLANWIRE_BASE = 'api.planwire.io';

const EPC_API_TOKEN = ENV.EPC_API_TOKEN || '';
const EPC_BASE = 'api.get-energy-performance-data.communities.gov.uk';

const SUPABASE_URL = 'jjegxgveeowrrgnfvaxn.supabase.co';
const SUPABASE_SERVICE_KEY = ENV.SUPABASE_SERVICE_KEY || '';
// Public anon/publishable key — matches js/supabase.js. Safe to embed; paired
// with a caller's own access token it only ever returns rows RLS allows them
// to see, which is what the portal-session route relies on.
const SUPABASE_ANON_KEY = 'sb_publishable_WWzB1IuUp8jYWZ10Mf2-xA_R_4ai4xI';

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

// Reconstruct the upstream path from a ?path= query param (mirrors api/planwire.js and api/epc.js)
function upstreamPathFromQuery(req) {
  const url = new URL(req.url, 'http://localhost');
  const subPath = (url.searchParams.get('path') || '').replace(/^\/+/, '');
  url.searchParams.delete('path');
  const qs = url.searchParams.toString();
  return '/' + subPath + (qs ? '?' + qs : '');
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

// Patch a Supabase profile row using the service-role key
function patchProfile(filterQs, fields) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(fields);
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/profiles?${filterQs}`,
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

const patchProfileById = (userId, fields) =>
  patchProfile(`id=eq.${encodeURIComponent(userId)}`, fields);

const patchProfileByCustomerId = (customerId, fields) =>
  patchProfile(`stripe_customer_id=eq.${encodeURIComponent(customerId)}`, fields);

// Look up a previously-saved Stripe customer for this user (service key), so
// a resubscribe after cancelling reuses the same Stripe customer.
function findStripeCustomerId(userId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_URL,
      path: `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
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

// Fetch the caller's own stripe_customer_id using their access token (anon
// key + RLS), not the service key — so a client can never open someone
// else's billing portal by passing a different userId.
function fetchOwnStripeCustomerId(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_URL,
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

// Fetch the caller's own plan + trial start using their access token (anon
// key + RLS) — same pattern as fetchOwnStripeCustomerId above. Used to gate
// the paid EPC/PlanWire proxies below.
function fetchOwnPlanStatus(accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_URL,
      path: '/rest/v1/profiles?select=plan,trial_started_at',
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
          resolve(Array.isArray(rows) && rows[0] ? rows[0] : null);
        } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

function isTrialExpired(profile) {
  if (!profile) return true;
  if (profile.plan === 'essential' || profile.plan === 'professional') return false;

  const start = new Date(profile.trial_started_at);
  if (isNaN(start.getTime())) return true;

  const trialEndMs = start.getTime() + 14 * 24 * 60 * 60 * 1000;
  return Date.now() >= trialEndMs;
}

// Gate for the paid EPC/PlanWire proxies — requires a valid Supabase
// access token for an account that's either on a paid plan or still inside
// its 14-day trial window. Fails closed: any missing token, invalid token, or
// lookup error blocks the request rather than letting it through. Returns
// false (and has already written the error response) if access is denied.
async function requireActiveAccess(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!accessToken) {
    jsonResponse(res, 401, { error: 'Missing access token' });
    return false;
  }

  let profile;
  try {
    profile = await fetchOwnPlanStatus(accessToken);
  } catch (err) {
    jsonResponse(res, 401, { error: 'Invalid access token' });
    return false;
  }

  if (!profile) {
    jsonResponse(res, 401, { error: 'Invalid access token' });
    return false;
  }

  if (isTrialExpired(profile)) {
    jsonResponse(res, 403, { error: 'trial_expired' });
    return false;
  }

  return true;
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

      const existingCustomerId = userId ? await findStripeCustomerId(userId) : null;

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        ...(existingCustomerId ? { customer: existingCustomerId } : { customer_email: email }),
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

  // ── Stripe: create billing portal session ──────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/stripe/create-portal-session') {
    const authHeader = req.headers['authorization'] || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!accessToken) return jsonResponse(res, 401, { error: 'Missing access token' });

    try {
      await readBody(req); // drain body, unused

      const customerId = await fetchOwnStripeCustomerId(accessToken);
      if (!customerId) return jsonResponse(res, 400, { error: 'No active subscription found for this account' });

      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `http://localhost:${PORT}/?portal_return=1`,
      });

      return jsonResponse(res, 200, { url: session.url });
    } catch (err) {
      console.error('Portal session error:', err.message);
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

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const plan = session.metadata && session.metadata.plan;

        if (userId && plan && SUPABASE_SERVICE_KEY) {
          await patchProfileById(userId, { plan, stripe_customer_id: session.customer });
          console.log(`Plan updated: user=${userId} plan=${plan} customer=${session.customer}`);
        } else if (!SUPABASE_SERVICE_KEY) {
          console.warn('SUPABASE_SERVICE_KEY not set — skipping profile update');
        }
      } else if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        if (customerId && SUPABASE_SERVICE_KEY) {
          // Access continues until Stripe actually closes the subscription out
          // at period end — this event only fires then. trial_started_at is
          // left untouched so this reads as an already-expired trial.
          await patchProfileByCustomerId(customerId, { plan: 'trial' });
          console.log(`Subscription ended: customer=${customerId} — plan reset to trial`);
        }
      }
    } catch (err) {
      console.error('Supabase update failed:', err.message);
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
  // All hit metered third-party APIs, so every call must be tied to a signed-in
  // account that's either on a paid plan or still within its trial window —
  // otherwise this is an open, unmetered tap on API quota we pay for.
  if (req.url.startsWith('/api/planwire')) {
    if (!(await requireActiveAccess(req, res))) return;
    return proxyRequest(req, res, PLANWIRE_BASE, upstreamPathFromQuery(req), { 'X-API-Key': PLANWIRE_KEY });
  }
  if (req.url.startsWith('/api/epc')) {
    if (!(await requireActiveAccess(req, res))) return;
    return proxyRequest(req, res, EPC_BASE, upstreamPathFromQuery(req), { 'Authorization': `Bearer ${EPC_API_TOKEN}` });
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
