-- =========================================================================
-- Gallery storage: ensure the bucket exists, is public, and has a
-- storage policy that allows anyone to read gallery images.
-- Without this policy, neither public URLs nor signed URLs work for
-- anonymous browser requests.
-- =========================================================================

-- Create bucket if it doesn't exist; force public if it does.
INSERT INTO storage.buckets (id, name, public)
VALUES ('gallery', 'gallery', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Allow anyone to read objects in the gallery bucket.
CREATE POLICY "Public gallery read"
ON storage.objects FOR SELECT
USING (bucket_id = 'gallery');

-- Allow authenticated (service_role) inserts and deletes for admin uploads.
CREATE POLICY "Service role gallery insert"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'gallery');

CREATE POLICY "Service role gallery delete"
ON storage.objects FOR DELETE
USING (bucket_id = 'gallery');
