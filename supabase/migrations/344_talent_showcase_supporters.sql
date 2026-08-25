-- Migration 344: Credit for who helped meet a Talent Showcase entry's
-- need. Admin tags one or more supporters once a need is partially or
-- fully met — each one either linked to an existing donor row (so their
-- name is picked from the real donor list, not retyped) or a free-text
-- name for help that never went through the online pledge flow (cash
-- given directly, a service donated, etc.). Multiple rows per entry is
-- the whole point — several people can be credited for the same need.
--
-- `name` is always a snapshot at the moment of crediting, same convention
-- as donors.name itself: it's the name the supporter chose to be shown
-- as, never a real/internal name pulled fresh from some other table.

CREATE TABLE talent_showcase_supporters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  talent_showcase_id uuid NOT NULL REFERENCES talent_showcases(id) ON DELETE CASCADE,
  donor_id uuid REFERENCES donors(id) ON DELETE SET NULL,
  name varchar NOT NULL,
  added_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX talent_showcase_supporters_entry_idx ON talent_showcase_supporters(talent_showcase_id);

ALTER TABLE talent_showcase_supporters ENABLE ROW LEVEL SECURITY;

CREATE POLICY "talent_showcase_supporters_admin_all" ON talent_showcase_supporters FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));

-- Public read, name only, and only for entries that are actually visible
-- on the public site — same narrow-view pattern as donors_public
-- (migration 116): owned by the migration role, deliberately not
-- security_invoker, so it can read past the admin-only base RLS through
-- this one chosen column list.
CREATE VIEW talent_showcase_supporters_public AS
SELECT s.id, s.talent_showcase_id, s.name, s.created_at
FROM talent_showcase_supporters s
WHERE EXISTS (SELECT 1 FROM talent_showcases t WHERE t.id = s.talent_showcase_id AND t.is_published = true);

GRANT SELECT ON talent_showcase_supporters_public TO anon, authenticated;

-- Set once, the first time support_status flips to 'fulfilled' — the
-- Achievements feed (migration 346) keys off this rather than an
-- always-moving updated_at, so a later unrelated edit (e.g. fixing a
-- typo) never reshuffles it in that feed.
ALTER TABLE talent_showcases ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;

CREATE OR REPLACE FUNCTION set_talent_showcase_fulfilled_at() RETURNS trigger AS $$
BEGIN
  IF NEW.support_status = 'fulfilled' AND OLD.support_status IS DISTINCT FROM 'fulfilled' AND NEW.fulfilled_at IS NULL THEN
    NEW.fulfilled_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_talent_showcase_fulfilled_at ON talent_showcases;
CREATE TRIGGER trg_talent_showcase_fulfilled_at BEFORE UPDATE ON talent_showcases
  FOR EACH ROW EXECUTE FUNCTION set_talent_showcase_fulfilled_at();
