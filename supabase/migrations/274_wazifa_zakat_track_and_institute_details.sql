-- Migration 274: schema for the zakat/standard track split, and what an
-- applicant actually needs to tell the committee to pay their institute or
-- hostel directly rather than through them.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The policy this sets up (built out fully in migrations 275-277)
-- ═════════════════════════════════════════════════════════════════════════
-- Every award now sits on one of two tracks, decided by whether the family
-- is already a verified zakat household — not by what the applicant asks
-- for. "Grant" (no repayment, ever) stops being a choice on the form:
--   - Zakat family: the committee funds 1-12 months while studying,
--     stoppable at any point; repayment only starts once the student is
--     employed (wazifa_mark_employed, migration 235 — already built,
--     never wired to an admission flow until now).
--   - Everyone else: the fixed monthly instalment starting at activation
--     (migration 269/270, built last time) — unchanged.

-- ── Mother's name, alongside the father's name that already existed ──────
ALTER TABLE wazifa_students
  ADD COLUMN IF NOT EXISTS mother_name varchar,
  -- Set only by a committee member confirming a suggested match — never
  -- automatically. wazifa_check_zakat_family() (migration 275) only ever
  -- proposes candidates; a name match is a lead, not proof.
  ADD COLUMN IF NOT EXISTS is_zakat_family boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zakat_match_register_id uuid REFERENCES needs_register(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS zakat_match_confirmed_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS zakat_match_confirmed_at timestamptz;

-- ── Only a parent applies for a child ─────────────────────────────────────
-- 'other_family' let a grandparent, sibling, or in practice anyone claiming
-- kinship submit on a child's behalf. Only a father or mother now can.
-- wazifa_application_self_only (migration 227) fires BEFORE INSERT OR
-- UPDATE and blocks any write with neither an admin nor a portal identity
-- set — which a migration run has neither of. Disabled for these two
-- backfill UPDATEs only, and re-enabled immediately after; nothing about
-- the guard itself changes.
ALTER TABLE wazifa_applications DISABLE TRIGGER wazifa_application_self_only;

UPDATE wazifa_applications SET applicant_relation = lower(trim(applicant_relation))
 WHERE applicant_relation IS NOT NULL;
UPDATE wazifa_applications SET applicant_for = 'own_child'
 WHERE applicant_for = 'other_family';
UPDATE wazifa_applications SET requested_as = 'loan' WHERE requested_as IN ('grant', 'either');

ALTER TABLE wazifa_applications ENABLE TRIGGER wazifa_application_self_only;

ALTER TABLE wazifa_applications DROP CONSTRAINT IF EXISTS wazifa_applications_applicant_for_check;
ALTER TABLE wazifa_applications ADD CONSTRAINT wazifa_applications_applicant_for_check
  CHECK (applicant_for IN ('self', 'own_child'));

ALTER TABLE wazifa_applications DROP CONSTRAINT IF EXISTS wazifa_applications_applicant_relation_check;
ALTER TABLE wazifa_applications ADD CONSTRAINT wazifa_applications_applicant_relation_check
  CHECK (applicant_for <> 'own_child' OR applicant_relation IN ('father', 'mother'));

-- ── "Grant" stops being a choice — every award sits on one of the two
--    tracks above, neither of which is a no-strings gift ─────────────────
ALTER TABLE wazifa_applications DROP CONSTRAINT IF EXISTS wazifa_applications_requested_as_check;
ALTER TABLE wazifa_applications ADD CONSTRAINT wazifa_applications_requested_as_check
  CHECK (requested_as = 'loan');
ALTER TABLE wazifa_applications ALTER COLUMN requested_as SET DEFAULT 'loan';

-- ── What the applicant knows about their own institute and hostel that
--    the committee does not — self-reported at application time, the same
--    way institution/programme/city already are. Enough to pay either
--    directly, and enough to call and ask if he is still attending. ──────
ALTER TABLE wazifa_applications
  ADD COLUMN IF NOT EXISTS institute_phone varchar,
  ADD COLUMN IF NOT EXISTS institute_address text,
  ADD COLUMN IF NOT EXISTS institute_registration_no varchar,
  ADD COLUMN IF NOT EXISTS institute_bank_account_title varchar,
  ADD COLUMN IF NOT EXISTS institute_bank_account_no varchar,
  ADD COLUMN IF NOT EXISTS institute_payment_number varchar,

  ADD COLUMN IF NOT EXISTS is_in_hostel boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hostel_name varchar,
  ADD COLUMN IF NOT EXISTS hostel_room_no varchar,
  ADD COLUMN IF NOT EXISTS hostel_monthly_charges_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hostel_phone varchar,
  ADD COLUMN IF NOT EXISTS hostel_beneficiary_name varchar,
  ADD COLUMN IF NOT EXISTS hostel_bank_account_title varchar,
  ADD COLUMN IF NOT EXISTS hostel_bank_account_no varchar,
  ADD COLUMN IF NOT EXISTS hostel_payment_number varchar;

-- ── A hostel is now a third place money can go, alongside the
--    institution and the student ─────────────────────────────────────────
ALTER TABLE wazifa_instalments DROP CONSTRAINT IF EXISTS wazifa_instalments_pay_to_check;
ALTER TABLE wazifa_instalments ADD CONSTRAINT wazifa_instalments_pay_to_check
  CHECK (pay_to IN ('institution', 'student', 'hostel'));
