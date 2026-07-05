-- Avalor — Supabase Database Schema
-- Run this in your Supabase SQL Editor (Database → SQL Editor → New query)

-- ─── PROFILES TABLE ──────────────────────────────────────────────────────────
create table if not exists profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text,
  email text,
  role text,
  plan text default 'trial',
  trial_started_at timestamptz default now(),
  onboarding_steps text default '{"1":false,"2":false,"3":false}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable Row Level Security
alter table profiles enable row level security;

-- Policies: users can only read/write their own profile
create policy "Users can view own profile"
  on profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert
  with check (auth.uid() = id);

-- ─── SAVED DEALS TABLE ───────────────────────────────────────────────────────
create table if not exists saved_deals (
  id bigserial primary key,
  user_id uuid references auth.users on delete cascade not null,
  postcode text not null,
  name text not null,
  dev_type text,
  prop_type text,
  region text,
  purchase numeric,
  floor_area numeric,
  units integer,
  gdv numeric,
  build_cost numeric,
  sdlt numeric,
  finance numeric,
  profit numeric,
  margin numeric,
  rlv numeric,
  growth_rate numeric,
  verdict text,
  appraisal_data text,
  share_token text unique,
  share_enabled boolean not null default false,
  created_at timestamptz default now()
);

-- Enable Row Level Security
alter table saved_deals enable row level security;

-- Policies: users can only access their own deals
create policy "Users can view own deals"
  on saved_deals for select
  using (auth.uid() = user_id);

create policy "Users can insert own deals"
  on saved_deals for insert
  with check (auth.uid() = user_id);

create policy "Users can delete own deals"
  on saved_deals for delete
  using (auth.uid() = user_id);

-- Only Professional-plan users can turn sharing on (share_enabled = true) for
-- their own deals — enforced here so it holds even if the app's UI is bypassed.
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

-- ─── AUTO-UPDATE TIMESTAMP ───────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_updated_at
  before update on profiles
  for each row execute procedure update_updated_at();
