-- =========================================================================
-- Add fields needed for the quote calculator:
--   diamond_carat   — customer-provided carat target
--   setting_style   — 'solitaire' | 'halo' | 'pave' | 'three-stone' | null
--   weight_class    — 'delicate' | 'standard' | 'substantial' | null
--   quote_total     — admin-entered approved quote, in USD cents
--   quote_notes     — admin-only notes
-- =========================================================================

alter table public.quote_requests
    add column if not exists diamond_carat numeric(4,2),
    add column if not exists setting_style text,
    add column if not exists weight_class  text,
    add column if not exists quote_total   integer,
    add column if not exists quote_notes   text;

-- Extend the allowed status values via a simple check constraint.
-- (If one exists already, drop it first.)
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
    check (status in ('new', 'quoted', 'won', 'lost'));
