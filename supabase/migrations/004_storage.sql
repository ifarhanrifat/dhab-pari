INSERT INTO storage.buckets (id, name, public)
VALUES
  ('images', 'images', true),
  ('thumbnails', 'thumbnails', true),
  ('videos', 'videos', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read images"
ON storage.objects FOR SELECT
USING (bucket_id IN ('images', 'thumbnails', 'videos'));

CREATE POLICY "Auth upload images"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id IN ('images', 'thumbnails', 'videos')
  AND auth.role() = 'authenticated'
);

CREATE POLICY "Auth delete images"
ON storage.objects FOR DELETE
USING (
  bucket_id IN ('images', 'thumbnails', 'videos')
  AND auth.role() = 'authenticated'
);
