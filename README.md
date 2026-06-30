# Avalor — Deployment Guide

## What's in this folder

```
avalor/
├── index.html          # The complete app (all pages)
├── schema.sql          # Database setup (run once in Supabase)
├── js/
│   ├── supabase.js     # Your Supabase credentials
│   ├── appraisal.js    # All calculation logic
│   ├── deals.js        # Saved deals + compare
│   └── app.js          # Auth, routing, UI
└── README.md           # This file
```

---

## Step 1 — Set up the database (10 mins)

1. Go to supabase.com → your Avalor project
2. Click SQL Editor in the left sidebar
3. Click New query
4. Open schema.sql from this folder and copy the entire contents
5. Paste into the SQL editor and click Run
6. You should see "Success. No rows returned"

---

## Step 2 — Enable email auth (5 mins)

1. In Supabase go to Authentication → Providers
2. Make sure Email is enabled (default)
3. Go to Authentication → URL Configuration and set:
   - Site URL: https://avalor.co.uk
   - Redirect URLs: https://avalor.co.uk

---

## Step 3 — Deploy to Vercel (15 mins)

3a — Push to GitHub:
1. Go to github.com, create a free account
2. Create a new repository called avalor
3. Upload all files from this folder

3b — Deploy on Vercel:
1. Go to vercel.com, sign up with GitHub
2. Click Add New Project
3. Select your avalor repository
4. Click Deploy

---

## Step 4 — Connect avalor.co.uk via 123-reg (15 mins)

In Vercel: Settings → Domains → Add avalor.co.uk and www.avalor.co.uk

In 123-reg:
1. Log in → Manage Domains → avalor.co.uk → Manage DNS
2. Edit A record → change IP to 76.76.21.21
3. Add CNAME: Name = www, Value = cname.vercel-dns.com
4. Save — DNS propagates within 30 mins usually

---

## Step 5 — Stripe (payments)

### Local testing

You need two terminals running simultaneously:

**Terminal 1 — the app server:**
```
node serve.js
```

**Terminal 2 — Stripe webhook forwarding:**
```
stripe listen --forward-to localhost:3456/api/stripe/webhook
```

When `stripe listen` starts, it prints a line like:
```
> Ready! Your webhook signing secret is whsec_abc123...
```

Copy that value and paste it into `.env` as `STRIPE_WEBHOOK_SECRET=whsec_abc123...`, then restart `node serve.js`.

### Supabase service role key (required for webhook to update plans)

The webhook updates `profiles.plan` in Supabase using the service-role key (which bypasses RLS). To add it:

1. Go to your Supabase project → Settings → API
2. Copy the **service_role** key (not the anon key)
3. Add it to `.env`: `SUPABASE_SERVICE_KEY=eyJ...`

### End-to-end test flow

1. Start both terminals above
2. Open http://localhost:3456, sign in
3. Click Upgrade → Choose a plan
4. Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC
5. After payment you're redirected back to `/?upgraded=1`
6. The app shows a confirmation toast and your tier badge updates

### Production deployment

When deploying to Vercel or similar:
- Add all `.env` variables as environment variables in the hosting dashboard
- Replace `localhost:3456` in `success_url` / `cancel_url` in `serve.js` with your real domain
- Create a live webhook endpoint in the Stripe dashboard (Developers → Webhooks → Add endpoint) pointing to `https://yourdomain.com/api/stripe/webhook`, listening for `checkout.session.completed`
- Use the webhook signing secret from the Stripe dashboard (not the CLI one) as `STRIPE_WEBHOOK_SECRET`
