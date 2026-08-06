-- Migration 115: Donor identity fields, sequential account numbers, and a
-- public-callable duplicate check — first step toward a real Donor Accounts
-- system (public registration + verification workflow, built in the
-- migrations that follow). Water Supply is untouched.

-- 1. Donor identity fields needed for dedup, receipt evidence, and the
--    verification workflow. `donors` stays one-row-per-donation (unchanged
--    shape) — these are per-donation fields, same as payment_method/notes.
ALTER TABLE donors
  ADD COLUMN IF NOT EXISTS father_husband_name varchar,
  ADD COLUMN IF NOT EXISTS whatsapp_number varchar,
  ADD COLUMN IF NOT EXISTS payment_proof_url text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS voucher_no varchar,
  ADD COLUMN IF NOT EXISTS submitted_via varchar NOT NULL DEFAULT 'staff'
    CHECK (submitted_via IN ('staff', 'public'));

-- 2. Friendly sequential donor account number ("DNR-00001"), separate from
--    the internal `code` (DON-<md5>) ensure_donor_account() already assigns.
--    Only ever set on type='donor' accounts, and only at first confirmation
--    (migration 117) — mirrors how a consumer number is issued once a
--    connection is actually approved, not on first contact.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS donor_account_no varchar UNIQUE;

CREATE SEQUENCE IF NOT EXISTS donor_account_no_seq START 1;

CREATE OR REPLACE FUNCTION next_donor_account_no() RETURNS varchar AS $$
  SELECT 'DNR-' || lpad(nextval('donor_account_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

-- 3. Public duplicate check — callable by anon (the public donation form,
--    migration 116, has no session to read `donors` directly through RLS).
--    Mirrors src/lib/duplicateCheck.ts's exact matching rules: mobile/whatsapp
--    exact match hard-blocks; name + father's name together hard-blocks; name
--    alone never blocks. Returns a human-readable message or NULL.
CREATE OR REPLACE FUNCTION check_donor_duplicate(
  p_name varchar, p_father_husband_name varchar, p_whatsapp_number varchar, p_phone varchar
) RETURNS text AS $$
DECLARE
  v_name varchar := lower(trim(p_name));
  v_father varchar := lower(trim(COALESCE(p_father_husband_name, '')));
  v_whatsapp varchar := lower(trim(COALESCE(p_whatsapp_number, '')));
  v_phone varchar := lower(trim(COALESCE(p_phone, '')));
  r RECORD;
BEGIN
  FOR r IN SELECT name, phone, whatsapp_number, father_husband_name FROM donors LOOP
    IF v_phone <> '' AND lower(trim(r.phone)) = v_phone THEN
      RETURN 'A donor with this phone number is already registered (' || r.name || ').';
    END IF;
    IF v_whatsapp <> '' AND lower(trim(r.whatsapp_number)) = v_whatsapp THEN
      RETURN 'A donor with this WhatsApp number is already registered (' || r.name || ').';
    END IF;
    IF v_name <> '' AND v_father <> '' AND lower(trim(r.name)) = v_name AND lower(trim(r.father_husband_name)) = v_father THEN
      RETURN 'A donor named "' || p_name || '" son/daughter of "' || p_father_husband_name || '" is already registered. If this is genuinely a different person, adjust the name slightly.';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION check_donor_duplicate(varchar, varchar, varchar, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_donor_duplicate(varchar, varchar, varchar, varchar) TO anon, authenticated;
