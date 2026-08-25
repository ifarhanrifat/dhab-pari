-- Migration 347: achievements_public gains a `source` discriminator
-- ('meeting' | 'manual' | 'project' | 'talent') — the new admin
-- Achievements page (manual_achievements CRUD) needs to tell them apart,
-- e.g. to only offer delete on the ones it actually owns.

DROP VIEW IF EXISTS achievements_public;
CREATE VIEW achievements_public AS
SELECT ai.id, ai.text_ur, ai.done_at, ai.is_private,
  CASE WHEN ai.is_private THEN NULL ELSE au.full_name END AS done_by_name,
  'meeting'::varchar AS source
FROM agenda_items ai
LEFT JOIN admin_users au ON au.id = ai.done_by_admin_user_id
WHERE ai.status = 'done'

UNION ALL

SELECT m.id, m.text_ur, m.occurred_at AS done_at, false AS is_private,
  au.full_name AS done_by_name, 'manual'::varchar AS source
FROM manual_achievements m
LEFT JOIN admin_users au ON au.id = m.added_by

UNION ALL

SELECT p.id, 'منصوبہ "' || COALESCE(p.title_ur, p.title) || '" مکمل ہو گیا۔' AS text_ur,
  p.completed_at AS done_at, false AS is_private, NULL::varchar AS done_by_name, 'project'::varchar AS source
FROM projects p
WHERE p.status = 'completed' AND p.completed_at IS NOT NULL

UNION ALL

SELECT ts.id, 'کمیونٹی نے "' || ts.display_name || '" کی ضرورت پوری کر دی۔' AS text_ur,
  ts.fulfilled_at AS done_at, false AS is_private,
  (SELECT string_agg(s.name, '، ' ORDER BY s.created_at) FROM talent_showcase_supporters s WHERE s.talent_showcase_id = ts.id) AS done_by_name,
  'talent'::varchar AS source
FROM talent_showcases ts
WHERE ts.support_status = 'fulfilled' AND ts.fulfilled_at IS NOT NULL AND ts.is_published = true

ORDER BY done_at DESC;

GRANT SELECT ON achievements_public TO anon, authenticated;
