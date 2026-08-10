-- Migration 188: blood requests — intake, approval, matching, response,
-- closure, cool-off and history.
--
-- Nobody can raise a request themselves. Every request is recorded by a
-- committee member from a phone call and then approved by someone holding the
-- blood permission. A fake request that reaches forty villagers at 2am is the
-- failure mode worth designing against, so both the person who took the call
-- and the person who approved it are recorded by name and time.

-- ── 1. Donor record gains what a real register needs ─────────────────────
-- Gender because the safe interval differs (12 weeks for men, 16 for women),
-- last_donation_date because without it the register will happily send someone
-- who gave three weeks ago, and consent because naming a donor publicly is not
-- ours to assume.
ALTER TABLE blood_donors
  ADD COLUMN IF NOT EXISTS gender varchar CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS last_donation_date date,
  ADD COLUMN IF NOT EXISTS city varchar,
  ADD COLUMN IF NOT EXISTS allow_public_thanks boolean NOT NULL DEFAULT false;

-- ── 2. Who may run this ──────────────────────────────────────────────────
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS can_manage_blood_requests boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION current_admin_permission(perm varchar) RETURNS boolean AS $$
  SELECT CASE
    WHEN role = 'viewer' THEN false
    WHEN role = 'super_admin' THEN true
    ELSE (CASE perm
      WHEN 'post_transactions' THEN can_post_transactions
      WHEN 'edit_transactions' THEN can_edit_transactions
      WHEN 'delete_transactions' THEN can_delete_transactions
      WHEN 'view_reports' THEN can_view_reports
      WHEN 'approve_transactions' THEN can_approve_transactions
      WHEN 'manage_parties' THEN can_manage_parties
      WHEN 'manage_accounts' THEN can_manage_accounts
      WHEN 'edit_accounts' THEN can_edit_accounts
      WHEN 'delete_accounts' THEN can_delete_accounts
      WHEN 'restore_deleted' THEN can_restore_deleted
      WHEN 'invite_users' THEN can_invite_users
      WHEN 'manage_blood_requests' THEN can_manage_blood_requests
      ELSE false
    END)
  END
  FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Admins get it by default; everyone else is granted it deliberately.
UPDATE admin_users SET can_manage_blood_requests = true WHERE role IN ('super_admin', 'admin');

-- ── 3. Red cell compatibility ────────────────────────────────────────────
-- Matching the exact group only is the classic amateur mistake: a patient
-- needing A+ can receive from A+, A-, O+ and O-, so exact-only search discards
-- roughly two thirds of the available pool.
CREATE OR REPLACE FUNCTION compatible_donor_groups(p_needed varchar) RETURNS text[] AS $$
  SELECT CASE p_needed
    WHEN 'O-'  THEN ARRAY['O-']
    WHEN 'O+'  THEN ARRAY['O-','O+']
    WHEN 'A-'  THEN ARRAY['O-','A-']
    WHEN 'A+'  THEN ARRAY['O-','O+','A-','A+']
    WHEN 'B-'  THEN ARRAY['O-','B-']
    WHEN 'B+'  THEN ARRAY['O-','O+','B-','B+']
    WHEN 'AB-' THEN ARRAY['O-','A-','B-','AB-']
    WHEN 'AB+' THEN ARRAY['O-','O+','A-','A+','B-','B+','AB-','AB+']
    ELSE ARRAY[]::text[]
  END;
$$ LANGUAGE sql IMMUTABLE;

-- 12 weeks for men, 16 for women — the interval used by most national services.
CREATE OR REPLACE FUNCTION blood_cooloff_days(p_gender varchar) RETURNS int AS $$
  SELECT CASE WHEN p_gender = 'female' THEN 112 ELSE 84 END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blood_donor_available_from(p_last date, p_gender varchar) RETURNS date AS $$
  SELECT CASE WHEN p_last IS NULL THEN NULL ELSE p_last + blood_cooloff_days(p_gender) END;
$$ LANGUAGE sql IMMUTABLE;

-- ── 4. Requests ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS blood_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_name varchar NOT NULL,
  requester_name varchar NOT NULL,
  requester_whatsapp varchar NOT NULL,
  requester_relation varchar,
  blood_group varchar NOT NULL CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  units_needed int NOT NULL DEFAULT 1 CHECK (units_needed > 0),
  city varchar NOT NULL,
  hospital varchar NOT NULL,
  needed_on date NOT NULL,
  needed_time varchar,
  notes text,

  status varchar NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval', 'open', 'paused', 'fulfilled', 'cancelled', 'expired')),

  -- Recorded from a phone call by a committee member; approved by someone with
  -- the permission. Both are named, both are timed.
  taken_by_admin_user_id uuid REFERENCES admin_users(id),
  taken_at timestamptz NOT NULL DEFAULT now(),
  approved_by_admin_user_id uuid REFERENCES admin_users(id),
  approved_at timestamptz,
  cancelled_by_admin_user_id uuid REFERENCES admin_users(id),
  cancelled_at timestamptz,
  cancel_reason text,
  fulfilled_at timestamptz,
  ticker_id uuid REFERENCES news_ticker(id) ON DELETE SET NULL,
  thanks_ticker_id uuid REFERENCES news_ticker(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blood_requests_status_idx ON blood_requests(status, needed_on);

ALTER TABLE blood_requests ENABLE ROW LEVEL SECURITY;
-- Staff read all; only the permission holder writes.
CREATE POLICY "blood_requests_staff_read" ON blood_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "blood_requests_manage" ON blood_requests FOR ALL TO authenticated
  USING (current_admin_permission('manage_blood_requests'))
  WITH CHECK (current_admin_permission('manage_blood_requests'));

-- Who was contacted, what they said, and whether they actually gave.
CREATE TABLE IF NOT EXISTS blood_request_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
  blood_donor_id uuid NOT NULL REFERENCES blood_donors(id) ON DELETE CASCADE,
  contacted_at timestamptz NOT NULL DEFAULT now(),
  contacted_by_admin_user_id uuid REFERENCES admin_users(id),
  channel varchar NOT NULL DEFAULT 'portal' CHECK (channel IN ('portal', 'whatsapp', 'call')),
  response varchar NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'yes', 'no', 'no_answer')),
  responded_at timestamptz,
  donated boolean NOT NULL DEFAULT false,
  stood_down_at timestamptz,
  UNIQUE (request_id, blood_donor_id)
);
CREATE INDEX IF NOT EXISTS blood_request_contacts_request_idx ON blood_request_contacts(request_id);

ALTER TABLE blood_request_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "blood_contacts_staff_read" ON blood_request_contacts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "blood_contacts_manage" ON blood_request_contacts FOR ALL TO authenticated
  USING (current_admin_permission('manage_blood_requests'))
  WITH CHECK (current_admin_permission('manage_blood_requests'));
-- A donor may answer their own contact row, and nothing else about it.
CREATE POLICY "blood_contacts_donor_read_own" ON blood_request_contacts FOR SELECT TO authenticated
  USING (blood_donor_id IN (SELECT id FROM blood_donors WHERE portal_user_id = current_portal_user_id()));
CREATE POLICY "blood_contacts_donor_respond" ON blood_request_contacts FOR UPDATE TO authenticated
  USING (blood_donor_id IN (SELECT id FROM blood_donors WHERE portal_user_id = current_portal_user_id()))
  WITH CHECK (blood_donor_id IN (SELECT id FROM blood_donors WHERE portal_user_id = current_portal_user_id()));

-- ── 5. Public counts, and nothing else ───────────────────────────────────
-- Names and numbers never leave the server. Published donor lists get spammed
-- and donors quietly de-register, which is how these registries die.
CREATE OR REPLACE FUNCTION blood_group_counts()
RETURNS TABLE (blood_group text, registered int, available_now int) AS $$
  SELECT g.grp::text,
         COUNT(d.id)::int,
         COUNT(d.id) FILTER (
           WHERE d.is_available
             AND (d.last_donation_date IS NULL
                  OR d.last_donation_date + blood_cooloff_days(d.gender) <= current_date)
         )::int
    FROM (VALUES ('O+'),('O-'),('A+'),('A-'),('B+'),('B-'),('AB+'),('AB-')) AS g(grp)
    LEFT JOIN blood_donors d ON d.blood_group = g.grp
   GROUP BY g.grp
   ORDER BY g.grp;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION blood_group_counts() TO anon, authenticated;

-- ── 6. Matching ──────────────────────────────────────────────────────────
-- Compatible groups, available, outside cool-off, same city first. Staff only:
-- this returns contact details.
CREATE OR REPLACE FUNCTION eligible_blood_donors(p_request_id uuid)
RETURNS TABLE (
  blood_donor_id uuid, full_name text, mobile text, whatsapp_number text,
  blood_group text, city text, sector text,
  last_donation_date date, available_from date, already_contacted boolean, response text
) AS $$
  SELECT d.id, pu.full_name::text, pu.mobile::text, pu.whatsapp_number::text,
         d.blood_group::text, d.city::text, d.sector::text,
         d.last_donation_date,
         blood_donor_available_from(d.last_donation_date, d.gender),
         c.id IS NOT NULL,
         c.response::text
    FROM blood_requests r
    JOIN blood_donors d
      ON d.blood_group = ANY (compatible_donor_groups(r.blood_group))
     AND d.is_available
     AND (d.last_donation_date IS NULL
          OR d.last_donation_date + blood_cooloff_days(d.gender) <= current_date)
    JOIN portal_users pu ON pu.id = d.portal_user_id AND pu.is_active
    LEFT JOIN blood_request_contacts c ON c.request_id = r.id AND c.blood_donor_id = d.id
   WHERE r.id = p_request_id
     AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
   ORDER BY (lower(d.city) IS NOT DISTINCT FROM lower(r.city)) DESC, d.updated_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION eligible_blood_donors(uuid) TO authenticated;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('blood_request', 'A blood request is approved and matches a donor', false, true),
  ('blood_stand_down', 'A blood request is cancelled or fulfilled', false, true)
ON CONFLICT (event_type) DO NOTHING;
