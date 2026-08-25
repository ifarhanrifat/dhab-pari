-- Migration 346: Achievements was only ever fed by committee meeting
-- task-todos (agenda_items marked done). Broadens it to a real running
-- record of everything the village should see as finished: completed
-- projects, Talent Showcase needs the community fulfilled (crediting
-- whoever helped — migration 344), and a general admin-authored lane for
-- anything that doesn't come from an automated status change (a new
-- feature launched, a one-off achievement worth announcing). The agenda
-- source (and its privacy rule) is untouched.

-- 1. Completed projects — set once, the first time status becomes
-- 'completed', same one-way-latch pattern as fulfilled_at (migration 344)
-- so a later unrelated edit never moves it in the feed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE OR REPLACE FUNCTION set_project_completed_at() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_completed_at ON projects;
CREATE TRIGGER trg_project_completed_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_project_completed_at();

-- 2. Freeform admin-authored achievements — a new portal feature shipped,
-- a one-off community achievement, anything real but not represented by
-- an automated status change elsewhere. Always public (an admin choosing
-- to announce something has no reason to also hide it).
CREATE TABLE manual_achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text_ur text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manual_achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "manual_achievements_admin_all" ON manual_achievements FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- 3. Rebuild achievements_public as a union of all four sources. Same
-- five columns as before (id, text_ur, done_at, is_private, done_by_name)
-- so the public Achievements page needs no changes at all. DROP + CREATE
-- rather than OR REPLACE — the live view's column order turned out to
-- already differ from what migration 153's source shows (id, done_at,
-- is_private, text_ur, done_by_name), which OR REPLACE refuses to change.
DROP VIEW IF EXISTS achievements_public;
CREATE VIEW achievements_public AS
SELECT ai.id, ai.text_ur, ai.done_at, ai.is_private,
  CASE WHEN ai.is_private THEN NULL ELSE au.full_name END AS done_by_name
FROM agenda_items ai
LEFT JOIN admin_users au ON au.id = ai.done_by_admin_user_id
WHERE ai.status = 'done'

UNION ALL

SELECT m.id, m.text_ur, m.occurred_at AS done_at, false AS is_private,
  au.full_name AS done_by_name
FROM manual_achievements m
LEFT JOIN admin_users au ON au.id = m.added_by

UNION ALL

SELECT p.id, 'منصوبہ "' || COALESCE(p.title_ur, p.title) || '" مکمل ہو گیا۔' AS text_ur,
  p.completed_at AS done_at, false AS is_private, NULL::varchar AS done_by_name
FROM projects p
WHERE p.status = 'completed' AND p.completed_at IS NOT NULL

UNION ALL

SELECT ts.id, 'کمیونٹی نے "' || ts.display_name || '" کی ضرورت پوری کر دی۔' AS text_ur,
  ts.fulfilled_at AS done_at, false AS is_private,
  (SELECT string_agg(s.name, '، ' ORDER BY s.created_at) FROM talent_showcase_supporters s WHERE s.talent_showcase_id = ts.id) AS done_by_name
FROM talent_showcases ts
WHERE ts.support_status = 'fulfilled' AND ts.fulfilled_at IS NOT NULL AND ts.is_published = true

ORDER BY done_at DESC;

GRANT SELECT ON achievements_public TO anon, authenticated;
