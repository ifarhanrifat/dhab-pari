-- Migration 310: Donor Badges v2 — water-themed tiers, admin-editable
-- thresholds, and a 5th honorary tier for committee members.
--
-- Replaces the bronze/silver/gold/platinum tiers from migration 138 (which
-- were only ever shown in one place — a small pill on project comments)
-- with a real, named badge system: Chashma (Spring), Nahar (Stream), Darya
-- (River), Samandar (Ocean) — based on a donor's lifetime VERIFIED giving,
-- same ledger-based computation as before — plus Sarchashma (Wellspring),
-- reserved for committee members and granted by hand from the admin Donor
-- Badges page, not earned by donation amount.
--
-- Thresholds move from hardcoded SQL literals to site_settings (same
-- softcoding move as migrations 307-309), so an admin can retune them
-- without a deploy.

INSERT INTO site_settings (key, value, description) VALUES
  ('badge_tier1_amount', '25000', 'Donor Badges — minimum lifetime confirmed giving (PKR) for Tier 1, Chashma (Spring).'),
  ('badge_tier2_amount', '150000', 'Donor Badges — minimum lifetime confirmed giving (PKR) for Tier 2, Nahar (Stream).'),
  ('badge_tier3_amount', '500000', 'Donor Badges — minimum lifetime confirmed giving (PKR) for Tier 3, Darya (River).'),
  ('badge_tier4_amount', '1000000', 'Donor Badges — minimum lifetime confirmed giving (PKR) for Tier 4, Samandar (Ocean).')
ON CONFLICT (key) DO NOTHING;

-- A manual override — currently only used for Sarchashma (committee
-- members), but written generically so staff can also hand-correct a tier
-- for a donor whose real history predates the portal. NULL means "use the
-- computed tier"; set means "always this tier, ignore the ledger total".
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS manual_badge_tier varchar
    CHECK (manual_badge_tier IN ('spring', 'stream', 'river', 'ocean', 'wellspring'));

CREATE OR REPLACE FUNCTION donor_badge_tier(p_portal_user_id uuid) RETURNS varchar AS $$
DECLARE
  v_manual varchar;
  v_account_id uuid;
  v_total decimal;
  v_t1 decimal; v_t2 decimal; v_t3 decimal; v_t4 decimal;
BEGIN
  SELECT manual_badge_tier, donor_account_id INTO v_manual, v_account_id
  FROM portal_users WHERE id = p_portal_user_id;
  IF v_manual IS NOT NULL THEN RETURN v_manual; END IF;
  IF v_account_id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(credit) - SUM(debit), 0) INTO v_total FROM ledger_entries WHERE account_id = v_account_id;

  SELECT value::decimal INTO v_t1 FROM site_settings WHERE key = 'badge_tier1_amount';
  SELECT value::decimal INTO v_t2 FROM site_settings WHERE key = 'badge_tier2_amount';
  SELECT value::decimal INTO v_t3 FROM site_settings WHERE key = 'badge_tier3_amount';
  SELECT value::decimal INTO v_t4 FROM site_settings WHERE key = 'badge_tier4_amount';

  RETURN CASE
    WHEN v_total >= COALESCE(v_t4, 1000000) THEN 'ocean'
    WHEN v_total >= COALESCE(v_t3, 500000) THEN 'river'
    WHEN v_total >= COALESCE(v_t2, 150000) THEN 'stream'
    WHEN v_total >= COALESCE(v_t1, 25000) THEN 'spring'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Granting/clearing the honorary tier — a narrow RPC rather than a blanket
-- admin UPDATE policy on portal_users (which would also expose mobile,
-- father's name, etc. to open-ended admin writes with no audit trail here).
CREATE OR REPLACE FUNCTION set_donor_manual_badge(p_portal_user_id uuid, p_tier varchar) RETURNS void AS $$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to grant donor badges';
  END IF;
  IF p_tier IS NOT NULL AND p_tier NOT IN ('spring', 'stream', 'river', 'ocean', 'wellspring') THEN
    RAISE EXCEPTION 'Invalid badge tier';
  END IF;
  UPDATE portal_users SET manual_badge_tier = p_tier WHERE id = p_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Donor not found'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_donor_manual_badge(uuid, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_donor_manual_badge(uuid, varchar) TO authenticated;

-- Admin-facing list: every portal user with either a real donation history
-- or a manual grant, their computed tier, and enough identity to act on —
-- powers the new /admin/donor-badges page without a bespoke query per row.
CREATE OR REPLACE VIEW donor_badges_admin AS
SELECT
  p.id AS portal_user_id, p.full_name, p.name_ur, p.username, p.mobile,
  p.manual_badge_tier,
  donor_badge_tier(p.id) AS badge_tier,
  COALESCE((SELECT SUM(credit) - SUM(debit) FROM ledger_entries WHERE account_id = p.donor_account_id), 0) AS total_donated_pkr
FROM portal_users p
WHERE p.is_active = true
  AND (p.donor_account_id IS NOT NULL OR p.manual_badge_tier IS NOT NULL);

GRANT SELECT ON donor_badges_admin TO authenticated;
ALTER VIEW donor_badges_admin SET (security_invoker = true);
-- security_invoker means this view's own SELECT runs as the calling user —
-- portal_users has no public SELECT policy (migration 121: read_own OR
-- staff only), so a non-staff, non-owning caller gets zero rows back, same
-- protection as querying portal_users directly.
