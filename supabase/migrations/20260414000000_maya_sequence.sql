-- Maya follow-up sequence columns
alter table public.quote_requests
  add column if not exists auto_sequence_enabled boolean not null default false,
  add column if not exists touch_count integer not null default 0,
  add column if not exists last_touch_at timestamptz,
  add column if not exists next_touch_at timestamptz,
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists sequence_log jsonb not null default '[]'::jsonb;

-- Index to make the scheduled query fast
create index if not exists quote_requests_sequence_ready_idx
  on public.quote_requests (next_touch_at)
  where auto_sequence_enabled = true and unsubscribed_at is null;
