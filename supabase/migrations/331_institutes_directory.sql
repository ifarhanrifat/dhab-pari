-- Migration 331: Phase B — institute directory. Plain reference content
-- ("where can I actually learn this") for the mentorship program's
-- registration-note promise. No moderation queue needed — only staff can
-- write it in the first place, same trust level as service_items or
-- sectors.
CREATE TABLE IF NOT EXISTS institutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  description text,
  address varchar,
  category varchar NOT NULL DEFAULT 'vocational'
    CHECK (category IN ('freelancing', 'vocational', 'academic', 'other')),
  subjects text,
  phone varchar,
  website varchar,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE institutes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "institutes_read" ON institutes FOR SELECT USING (is_active = true);
-- FOR ALL already covers SELECT, so this alone gives admin visibility into
-- inactive rows too (needed to un-hide one), not just write access.
CREATE POLICY "institutes_write" ON institutes FOR ALL TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));
