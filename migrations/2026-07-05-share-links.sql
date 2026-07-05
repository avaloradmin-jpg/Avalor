-- Avalor — Share links migration
-- Run in Supabase SQL Editor (Database → SQL Editor → New query) before deploying the share-link feature.

alter table saved_deals
  add column if not exists share_token text unique,
  add column if not exists share_enabled boolean not null default false;

-- Replace the update policy so only Professional-plan users can turn sharing on
-- for their own deals. Enforced at the DB level via WITH CHECK, so it holds even
-- if a request bypasses the app's UI and calls the Supabase REST API directly.
drop policy if exists "Users can update own deals" on saved_deals;

create policy "Users can update own deals"
  on saved_deals for update
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      share_enabled = false
      or exists (
        select 1 from profiles
        where profiles.id = auth.uid() and profiles.plan = 'professional'
      )
    )
  );

-- Note: no new SELECT policy is added for anon/public access. Public reads for
-- shared deals go through api/shared-deal.js using the service-role key, which
-- does an exact share_token match and returns only a whitelisted set of columns.
-- A public RLS policy like `using (share_enabled = true)` would let anyone with
-- the anon key list every shared deal from every user, not just the one they
-- have the token for — RLS gates rows, not "must supply the exact token".
