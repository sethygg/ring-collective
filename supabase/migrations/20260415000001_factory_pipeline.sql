-- =========================================================================
-- Factory pipeline:
--   • Adds `in_production` to the allowed status values.
--   • Adds `factory_sent_at` timestamp so admin UI can show when the packet
--     was emailed and disable the button (or switch it to Resend).
-- =========================================================================

alter table public.quote_requests
  add column if not exists factory_sent_at timestamptz;

-- Replace the status check constraint to include 'in_production'.
do $$
begin
    if exists (
        select 1 from pg_constraint
        where conname = 'quote_requests_status_check'
    ) then
        alter table public.quote_requests drop constraint quote_requests_status_check;
    end if;
end $$;

alter table public.quote_requests
    add constraint quote_requests_status_check
    check (status in ('new', 'quoted', 'won', 'in_production', 'lost'));

comment on column public.quote_requests.factory_sent_at is
  'Timestamp of the most recent factory packet send. Admin UI disables the button or labels it Resend when set.';
