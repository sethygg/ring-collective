-- =========================================================================
-- Gallery pieces — portfolio of completed rings.
-- Admin uploads images + price from admin.html; homepage shows the 8 most
-- recent; recent-work.html shows the full gallery.
-- Images live in the public 'gallery' Supabase Storage bucket so they can
-- be loaded without signed URLs.
-- =========================================================================

create table if not exists public.gallery_pieces (
  id            uuid primary key default gen_random_uuid(),
  image_path    text not null,                          -- path inside the 'gallery' storage bucket
  title         text not null default '',                -- admin-facing label (e.g. "Oval Halo 14K")
  description   text not null default '',                -- optional short blurb shown on card
  price_cents   integer not null,                        -- price the client paid, in cents
  display_order integer not null default 0,              -- lower = shown first; admin can reorder
  is_active     boolean not null default true,           -- soft-delete; inactive pieces hidden from public
  created_at    timestamptz not null default now()
);

-- Public read access for the anon key (homepage + gallery page).
alter table public.gallery_pieces enable row level security;

create policy "Public can read active gallery pieces"
  on public.gallery_pieces for select
  using (is_active = true);

-- Index for the homepage query (8 most recent, ordered).
create index if not exists idx_gallery_active_order
  on public.gallery_pieces (is_active, display_order asc, created_at desc);

comment on table public.gallery_pieces is
  'Portfolio gallery of completed rings. Admin uploads image + price; homepage shows recent 8.';
