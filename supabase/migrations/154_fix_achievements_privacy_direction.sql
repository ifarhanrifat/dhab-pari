-- Migration 154: achievements_public (migration 153) had the private/public
-- fields backwards — it hid the *name* and kept the *task detail* visible
-- for private items, the opposite of what was asked: "private job done by
-- the member" should hide the detail but still name who did it (visible
-- that work happened, not what).
-- CREATE OR REPLACE VIEW can't reorder columns, only append — drop first.
DROP VIEW IF EXISTS achievements_public;
CREATE VIEW achievements_public AS
SELECT ai.id, ai.done_at, ai.is_private,
  CASE WHEN ai.is_private THEN NULL ELSE ai.text_ur END AS text_ur,
  au.full_name AS done_by_name
FROM agenda_items ai
LEFT JOIN admin_users au ON au.id = ai.done_by_admin_user_id
WHERE ai.status = 'done'
ORDER BY ai.done_at DESC;

GRANT SELECT ON achievements_public TO anon, authenticated;
