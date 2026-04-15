-- Accent/melee diamond detection fields.
-- Populated by detect-ring.js (AI vision) when photos are uploaded,
-- then surfaced in admin quote calculator so the estimated accent
-- stone cost is factored into the total.

alter table quote_requests
  add column if not exists accent_pattern text
    check (accent_pattern in ('none','shoulders','half-eternity','three-quarter-eternity','full-eternity')),
  add column if not exists accent_melee_size text
    check (accent_melee_size in ('none','small','medium','large')),
  add column if not exists hidden_halo boolean default false,
  add column if not exists estimated_accent_count int,
  add column if not exists estimated_accent_tcw numeric(6,3);

comment on column quote_requests.accent_pattern is
  'AI-detected band accent coverage pattern.';
comment on column quote_requests.accent_melee_size is
  'AI-detected size class of band accent stones.';
comment on column quote_requests.hidden_halo is
  'AI-detected hidden halo under the center stone.';
comment on column quote_requests.estimated_accent_count is
  'Server-computed stone count from pattern + size.';
comment on column quote_requests.estimated_accent_tcw is
  'Server-computed total carat weight of accent diamonds.';
