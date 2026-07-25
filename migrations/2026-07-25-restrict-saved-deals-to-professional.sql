-- Avalor — Restrict saving deals and comparison to Professional-plan users
-- Run in Supabase SQL Editor (Database → SQL Editor → New query) before deploying
-- the pricing-tier enforcement.
--
-- The live database has an existing insert policy named
-- "Only trial and professional can save deals", which currently allows both
-- trial and Professional to insert into saved_deals. Under the new model
-- (trial gets the full on-screen appraisal experience only, with no
-- export/save/share/compare), that policy needs to be replaced so that ONLY
-- Professional-plan users can insert — trial and Essential both excluded.
--
-- This drops the actual live policy by its real name (confirmed via the
-- pg_policies inspection query) and replaces it with a Professional-only
-- policy named "Users can insert own deals", matching the naming convention
-- used by the table's other policies (see schema.sql).

drop policy if exists "Only trial and professional can save deals" on saved_deals;

-- Defensive: also drop the name this migration originally shipped with, in
-- case it was applied under that name during earlier testing.
drop policy if exists "Users can insert own deals" on saved_deals;

create policy "Users can insert own deals"
  on saved_deals for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.plan = 'professional'
    )
  );

-- Run this to confirm only the one policy above remains on INSERT:
--
-- select policyname, cmd, qual, with_check
-- from pg_policies
-- where tablename = 'saved_deals';
