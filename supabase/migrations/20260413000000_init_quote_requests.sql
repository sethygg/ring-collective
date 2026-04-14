-- =========================================================================
-- Ring Collective — initial schema
-- Creates the quote_requests table, a ring-photos storage bucket,
-- and row-level security so the public can submit but not read.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. quote_requests table
-- -------------------------------------------------------------------------
create table if not exists public.quote_requests (
    id              uuid primary key default gen_random_uuid(),
    created_at      timestamptz not null default now(),
    status          text not null default 'new',

    -- contact
    name            text not null,
    email           text not null,
    phone           text,

    -- ring details (from the chatbot answers)
    stone_category  text,   -- 'diamond' | 'colored'
    stone_type      text,   -- e.g. 'Lab Diamond', 'Moissanite', 'Sapphire', 'Other'
    stone_type_note text,   -- free-text when user picks "Other"
    shape           text,   -- 'Round', 'Oval', 'Emerald', etc.
    metal           text,   -- 'White Gold', 'Yellow Gold', 'Rose Gold', 'Platinum'
    karat           text,   -- '14K' | '18K' | null (platinum)
    ring_size       text,

    -- project
    budget          text,
    timeline        text,
    custom_date     date,

    -- photo object paths inside the ring-photos storage bucket
    photo_paths     text[] not null default '{}',

    -- keep the full raw answers blob for debugging / future fields
    raw_answers     jsonb
);

create index if not exists quote_requests_created_at_idx
    on public.quote_requests (created_at desc);

create index if not exists quote_requests_status_idx
    on public.quote_requests (status);

-- -------------------------------------------------------------------------
-- 2. Row Level Security
-- -------------------------------------------------------------------------
alter table public.quote_requests enable row level security;

-- Anyone (including anonymous website visitors) can submit a new quote.
drop policy if exists "Public can insert quote requests" on public.quote_requests;
create policy "Public can insert quote requests"
    on public.quote_requests
    for insert
    to anon, authenticated
    with check (true);

-- Nobody can SELECT / UPDATE / DELETE via the public API.
-- You access rows via the Supabase dashboard or a service_role key only.

-- -------------------------------------------------------------------------
-- 3. Storage bucket for uploaded ring photos
-- -------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ring-photos', 'ring-photos', false)
on conflict (id) do nothing;

-- Allow anyone to upload to the ring-photos bucket.
drop policy if exists "Public can upload ring photos" on storage.objects;
create policy "Public can upload ring photos"
    on storage.objects
    for insert
    to anon, authenticated
    with check (bucket_id = 'ring-photos');

-- No public read — photos are reviewed via the Supabase dashboard
-- or via signed URLs generated server-side.
