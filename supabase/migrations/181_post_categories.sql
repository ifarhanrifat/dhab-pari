-- Migration 181: make post categories data instead of a constraint.
--
-- news_posts.category carried a hardcoded CHECK listing seven values. Adding
-- "Editorial" or "Poetry" therefore meant a schema migration and a deploy —
-- for what is, to the committee, just another kind of post. That is the exact
-- friction that makes people ask for a whole new page and a whole new table
-- instead, and it is how a content system ends up as six near-identical
-- features that all have to be maintained separately.
--
-- Note what this migration does NOT do: it does not merge video_content,
-- gallery_albums or news_ticker into news_posts. Those are genuinely different
-- shapes — a video has a URL and a duration, a gallery has albums of images, a
-- ticker line is one sentence that scrolls. Merging them would be pushing
-- unlike things into one table for the sake of tidiness. Only articles belong
-- together, and Editorial and Poetry are articles.
CREATE TABLE IF NOT EXISTS post_categories (
  key varchar PRIMARY KEY,
  label_en varchar NOT NULL,
  label_ur varchar NOT NULL,
  icon varchar,
  display_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

ALTER TABLE post_categories ENABLE ROW LEVEL SECURITY;
-- Readable by anyone: the public news page filters by category.
CREATE POLICY "post_categories_read" ON post_categories FOR SELECT USING (true);
CREATE POLICY "post_categories_write" ON post_categories FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

INSERT INTO post_categories (key, label_en, label_ur, icon, display_order) VALUES
  ('announcement', 'Announcement', 'اعلان',      '📢', 1),
  ('event',        'Event',        'تقریب',      '📅', 2),
  ('social',       'Social',       'سماجی',      '🤝', 3),
  ('health',       'Health',       'صحت',        '🏥', 4),
  ('education',    'Education',    'تعلیم',      '📚', 5),
  ('environment',  'Environment',  'ماحولیات',   '🌱', 6),
  ('sports',       'Sports',       'کھیل',       '⚽', 7),
  ('editorial',    'Editorial',    'اداریہ',     '✍️', 8),
  ('poetry',       'Poetry',       'شاعری',      '🖋️', 9)
ON CONFLICT (key) DO NOTHING;

-- Swap the CHECK for a foreign key. Every value already in news_posts is in the
-- seed above, so nothing is orphaned; adding the tenth category from now on is
-- an INSERT, not a migration.
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con FROM pg_constraint
   WHERE conrelid = 'news_posts'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%category%';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE news_posts DROP CONSTRAINT %I', v_con);
  END IF;
END $$;

-- Guard against a stray value blocking the FK: anything unrecognised becomes an
-- announcement rather than failing the migration outright.
UPDATE news_posts SET category = 'announcement'
 WHERE category IS NOT NULL
   AND category NOT IN (SELECT key FROM post_categories);

ALTER TABLE news_posts DROP CONSTRAINT IF EXISTS news_posts_category_fkey;
ALTER TABLE news_posts
  ADD CONSTRAINT news_posts_category_fkey
  FOREIGN KEY (category) REFERENCES post_categories(key);
