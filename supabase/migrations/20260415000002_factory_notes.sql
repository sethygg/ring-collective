-- Adds a free-text notes field for the production packet so Seth can add
-- custom instructions to the factory per-lead (stone preferences,
-- finishing requests, deadline notes, etc.). Persisted so resends show the
-- last notes in the textarea by default.

alter table public.quote_requests
  add column if not exists factory_notes text;

comment on column public.quote_requests.factory_notes is
  'Custom notes Seth typed in the admin modal before sending the factory packet.';
