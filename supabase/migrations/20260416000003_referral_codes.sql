-- =========================================================================
-- Referral tracking: codes table + attribution column on quote_requests
-- =========================================================================

-- 1. Referral codes — managed by admin
CREATE TABLE IF NOT EXISTS public.referral_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,          -- short slug, e.g. 'jake'
    name        text NOT NULL DEFAULT '',       -- human label, e.g. 'Jake Smith'
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_codes_code_idx
    ON public.referral_codes (code);

-- RLS: only service_role can read/write (admin endpoint uses service_role key)
ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- 2. Add ref_code column to quote_requests so every lead carries its source
ALTER TABLE public.quote_requests
    ADD COLUMN IF NOT EXISTS ref_code text;

CREATE INDEX IF NOT EXISTS quote_requests_ref_code_idx
    ON public.quote_requests (ref_code);
