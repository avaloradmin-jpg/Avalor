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

## Step 5 — Next: Stripe + PlanWire

Come back after the app is live and we'll wire these up.
