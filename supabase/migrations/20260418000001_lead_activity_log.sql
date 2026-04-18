-- Lead activity log — records status changes, factory sends, notes, etc.
-- Each row is one event on one lead.

CREATE TABLE IF NOT EXISTS public.lead_activity_log (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id     uuid NOT NULL REFERENCES public.quote_requests(id) ON DELETE CASCADE,
  event_type  text NOT NULL,        -- 'status_change', 'factory_sent', 'quote_saved', 'quote_sent', 'note', 'created'
  old_value   text,                 -- e.g. previous status
  new_value   text,                 -- e.g. new status or quote total
  detail      text,                 -- free-text detail (notes, factory email, etc.)
  created_at  timestamptz DEFAULT now()
);

-- Index for fast lookups by lead
CREATE INDEX IF NOT EXISTS idx_activity_lead_id ON public.lead_activity_log(lead_id);

-- Index for chronological ordering
CREATE INDEX IF NOT EXISTS idx_activity_created ON public.lead_activity_log(created_at DESC);

-- Allow the service_role key full access (admin.js uses service_role to bypass RLS)
ALTER TABLE public.lead_activity_log ENABLE ROW LEVEL SECURITY;

-- Backfill: create a "created" event for every existing lead so the timeline isn't empty
INSERT INTO public.lead_activity_log (lead_id, event_type, created_at)
SELECT id, 'created', created_at
FROM public.quote_requests
ON CONFLICT DO NOTHING;
