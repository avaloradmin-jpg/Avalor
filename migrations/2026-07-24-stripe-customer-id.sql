-- Avalor — Stripe customer ID migration
-- Run in Supabase SQL Editor (Database → SQL Editor → New query) before deploying
-- the subscription cancellation feature.
--
-- Stores the Stripe Customer object ID for each user so the Billing Portal
-- (and future checkouts) can look up the right customer without trusting a
-- client-supplied ID. Populated by the checkout.session.completed webhook.

alter table profiles
  add column if not exists stripe_customer_id text;

create index if not exists profiles_stripe_customer_id_idx
  on profiles (stripe_customer_id);
