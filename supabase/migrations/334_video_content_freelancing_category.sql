-- Migration 334: video_content.category is a hard CHECK list (migration
-- 001) missing the one category the mentorship program's course-video
-- library actually needs.
ALTER TABLE video_content DROP CONSTRAINT IF EXISTS video_content_category_check;
ALTER TABLE video_content ADD CONSTRAINT video_content_category_check
  CHECK (category IN ('wedding', 'interview', 'event', 'sports', 'news', 'documentary', 'project', 'freelancing'));
