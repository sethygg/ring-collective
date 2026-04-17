-- =========================================================================
-- Add ring spec fields to gallery_pieces so admin can record what was built.
-- These are shown on the "I Want This Ring" page but NOT on homepage cards.
-- =========================================================================

ALTER TABLE public.gallery_pieces
    ADD COLUMN IF NOT EXISTS stone_carat  numeric,
    ADD COLUMN IF NOT EXISTS stone_type   text,
    ADD COLUMN IF NOT EXISTS metal_type   text;
