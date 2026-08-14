-- Migration 237: the sadqa-e-jariya catalogue stops being something only a
-- migration can change, and upkeep stops being one pool per object.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Urgent fix first: pool_announce is broken in production right now
-- ═════════════════════════════════════════════════════════════════════════
-- CREATE OR REPLACE FUNCTION cannot change a function's argument list — doing
-- so creates a second, separate overload instead of replacing the first.
-- Migration 236 added two new parameters to pool_announce and to
-- pool_post_confirmed_payment without ever dropping the older, shorter
-- signature first, so both now exist side by side. Confirmed live: exactly
-- two overloads of each sit in the schema right now.
--
-- The donor portal's "join a pool" screen (support/page.tsx) calls
-- pool_announce with only the original five named parameters — a call that
-- matches both overloads equally well, since the newer one's extra
-- parameters both default to NULL. Verified directly against a schema
-- identical to production: that exact call fails with "function
-- pool_announce(...) is not unique" — a real, live PostgREST error, meaning
-- every donor trying to join or pledge to a pool since migration 236 shipped
-- has been unable to. This is not new breakage from today's migration; it is
-- a bug already on dhabpari.com that this migration also needed to touch
-- pool_announce for, so it is fixed here rather than left for a separate
-- emergency migration.
--
-- The fix is to drop every old overload before creating the new one, which
-- is what should have happened in migration 236.
DROP FUNCTION IF EXISTS pool_announce(uuid, decimal, boolean, varchar, boolean);
DROP FUNCTION IF EXISTS pool_announce(uuid, decimal, boolean, varchar, boolean, uuid, uuid);
DROP FUNCTION IF EXISTS pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text);
DROP FUNCTION IF EXISTS pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text, uuid, uuid);

-- ═════════════════════════════════════════════════════════════════════════
-- The catalogue had no admin screen at all
-- ═════════════════════════════════════════════════════════════════════════
-- Water cooler, hand pump, submersible pump, solar light — every item and
-- every price came from migration 210's own seed data, and nothing since has
-- ever written to sadqa_catalogue. Adding an item, retiring one, or fixing a
-- price required editing SQL by hand — exactly the "nothing hardcoded" rule
-- already set for this system, unenforced here.
--
-- Changing a price here is safe by construction and needs no extra
-- versioning: sadqa_objects already copies capital_cost_pkr and
-- annual_running_cost_pkr onto itself the moment a donor offers one (see the
-- portal page's insert), so an object already offered keeps the price it was
-- offered at — only a new offer ever sees a changed catalogue price.
CREATE OR REPLACE FUNCTION sadqa_catalogue_create(
  p_name varchar, p_name_ur varchar, p_capital_cost decimal, p_annual_running_cost decimal,
  p_expected_life_years int DEFAULT NULL, p_description text DEFAULT NULL,
  p_description_ur text DEFAULT NULL, p_image_url text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE v_id uuid; v_order int;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Give the item a name donors will recognise.' USING ERRCODE = 'P0001';
  END IF;
  IF p_capital_cost < 0 OR p_annual_running_cost < 0 THEN
    RAISE EXCEPTION 'Costs cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(MAX(display_order), 0) + 1 INTO v_order FROM sadqa_catalogue;

  INSERT INTO sadqa_catalogue (name, name_ur, capital_cost_pkr, annual_running_cost_pkr,
    expected_life_years, description, description_ur, image_url, display_order)
  VALUES (p_name, p_name_ur, p_capital_cost, p_annual_running_cost,
    p_expected_life_years, p_description, p_description_ur, p_image_url, v_order)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION sadqa_catalogue_update(
  p_id uuid, p_name varchar DEFAULT NULL, p_name_ur varchar DEFAULT NULL,
  p_capital_cost decimal DEFAULT NULL, p_annual_running_cost decimal DEFAULT NULL,
  p_expected_life_years int DEFAULT NULL, p_description text DEFAULT NULL,
  p_description_ur text DEFAULT NULL, p_image_url text DEFAULT NULL,
  p_display_order int DEFAULT NULL
) RETURNS jsonb AS $$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_capital_cost IS NOT NULL AND p_capital_cost < 0 THEN
    RAISE EXCEPTION 'Cost cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_catalogue SET
    name = COALESCE(p_name, name), name_ur = COALESCE(p_name_ur, name_ur),
    capital_cost_pkr = COALESCE(p_capital_cost, capital_cost_pkr),
    annual_running_cost_pkr = COALESCE(p_annual_running_cost, annual_running_cost_pkr),
    expected_life_years = COALESCE(p_expected_life_years, expected_life_years),
    description = COALESCE(p_description, description),
    description_ur = COALESCE(p_description_ur, description_ur),
    image_url = COALESCE(p_image_url, image_url),
    display_order = COALESCE(p_display_order, display_order)
  WHERE id = p_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Retired, not deleted — every existing sadqa_objects row keeps its own
-- catalogue_id reference, and their own copied price is untouched either
-- way. Retiring just stops the item being offered again.
CREATE OR REPLACE FUNCTION sadqa_catalogue_retire(p_id uuid, p_retire boolean DEFAULT true) RETURNS jsonb AS $$
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE sadqa_catalogue SET is_active = NOT p_retire WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION sadqa_catalogue_create(varchar, varchar, decimal, decimal, int, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_catalogue_update(uuid, varchar, varchar, decimal, decimal, int, text, text, text, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_catalogue_retire(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sadqa_catalogue_create(varchar, varchar, decimal, decimal, int, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_catalogue_update(uuid, varchar, varchar, decimal, decimal, int, text, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_catalogue_retire(uuid, boolean) TO authenticated;

-- RLS already allowed an authenticated donors_projects admin to write this
-- table directly (migration 210's own sadqa_catalogue_admin policy) — the
-- gap was never permissions, it was that nothing in the app ever called it.
-- These RPCs are that missing caller; no policy change needed.

-- ═════════════════════════════════════════════════════════════════════════
-- Upkeep — one shared pool instead of one per object
-- ═════════════════════════════════════════════════════════════════════════
-- sadqa_publish_upkeep_pool() (migration 226) made a new pool every time it
-- was called — a cooler here, a solar light there, each with its own
-- donor-facing screen to join. For a village that may eventually maintain
-- twenty of these, twenty separate pools is not the "one simple system" this
-- whole redesign has been aiming for. One shared pool now covers every
-- committee-maintained object's upkeep together; a donor can still pick one
-- specific object to name, the same "pick one or join the shared pot" choice
-- Kafalat and Wazifa now both offer, through the same pool_announce() path.
INSERT INTO support_pools (code, name, name_ur, kind, fund_type, suggested_share_pkr, min_share_pkr,
                           description, description_ur)
VALUES ('POOL-SDQ', 'Mushtarka Sadqa-e-Jariya Upkeep — keeping everything running',
        'مشترکہ صدقہ جاریہ دیکھ بھال — ہر چیز کو چلتا رکھنا',
        'general', 'sadqa', 500, 200,
        'Electricity, filters and repairs for every water cooler, hand pump, solar light and other object the committee has taken on — carried together instead of waiting on whoever gave it originally.',
        'ہر واٹر کولر، ہینڈ پمپ، سولر لائٹ اور دیگر اشیاء کی بجلی، فلٹر اور مرمت — عطیہ دینے والے کے اکیلے بوجھ کے بجائے سب مل کر اٹھاتے ہیں۔')
ON CONFLICT (code) DO NOTHING;

-- sadqa_publish_upkeep_pool() (below) is superseded — anything wanting to
-- name one object's upkeep now uses pool_announce() against POOL-SDQ with a
-- sadqa_object_id, the same pattern as naming a Kafalat child.
ALTER TABLE pool_commitments
  ADD COLUMN IF NOT EXISTS sadqa_object_id uuid REFERENCES sadqa_objects(id) ON DELETE SET NULL;
ALTER TABLE pool_payments
  ADD COLUMN IF NOT EXISTS sadqa_object_id uuid REFERENCES sadqa_objects(id) ON DELETE SET NULL;

ALTER TABLE pool_commitments DROP CONSTRAINT IF EXISTS pool_commitments_one_target;
ALTER TABLE pool_commitments ADD CONSTRAINT pool_commitments_one_target CHECK (
  (kafalat_child_id IS NOT NULL)::int + (wazifa_student_id IS NOT NULL)::int
    + (sadqa_object_id IS NOT NULL)::int <= 1
);

-- pool_monthly_target's requirement for the shared upkeep pool: every
-- committee-maintained object's own monthly upkeep rate, added together.
CREATE OR REPLACE FUNCTION sadqa_upkeep_total_required() RETURNS decimal AS $$
  SELECT COALESCE(SUM(sadqa_monthly_cost(id)), 0)
    FROM sadqa_objects
   WHERE maintenance_mode = 'committee' AND status IN ('installed', 'in_service', 'needs_repair');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION sadqa_upkeep_total_required() TO authenticated;

CREATE OR REPLACE FUNCTION pool_monthly_target(p_pool_id uuid) RETURNS decimal AS $$
DECLARE p support_pools%ROWTYPE; v decimal;
BEGIN
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF p.manual_monthly_target_pkr IS NOT NULL THEN RETURN p.manual_monthly_target_pkr; END IF;

  IF p.kind = 'kafalat' THEN
    v := (kafalat_measuring_position()->>'monthly_target')::decimal;
  ELSIF p.kind = 'wazifa' THEN
    v := (wazifa_measuring_position()->>'monthly_target')::decimal;
  ELSIF p.code = 'POOL-SDQ' THEN
    v := sadqa_upkeep_total_required();
  ELSIF p.kind = 'project' AND p.project_id IS NOT NULL THEN
    SELECT COALESCE(monthly_operating_cost_pkr, 0) INTO v FROM projects WHERE id = p.project_id;
  ELSE
    v := 0;
  END IF;
  RETURN COALESCE(round(v), 0);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- The old per-object flow published a brand-new pool (POOL-<object_no>) the
-- first time an admin clicked "share the upkeep" for that object. It now
-- just attaches the object to the one shared pool instead — the admin
-- screen's existing button keeps working unchanged, it just no longer
-- multiplies pools. maintenance_pool_id is kept for that screen's own
-- "already published?" check; nothing else depends on it any more, since
-- sadqa_upkeep_total_required() and sadqa_objects_for_naming() already pick
-- up every committee-maintained object automatically regardless of it.
CREATE OR REPLACE FUNCTION sadqa_publish_upkeep_pool(p_object_id uuid, p_share_pkr decimal DEFAULT 500)
RETURNS jsonb AS $$
DECLARE o sadqa_objects%ROWTYPE; v_pool uuid;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.maintenance_mode <> 'committee' THEN
    RAISE EXCEPTION 'Only an object the committee has taken on can be shared out this way.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_pool FROM support_pools WHERE code = 'POOL-SDQ';
  UPDATE sadqa_objects SET maintenance_pool_id = v_pool, updated_at = now() WHERE id = p_object_id;
  RETURN jsonb_build_object('pool_id', v_pool, 'monthly', sadqa_monthly_cost(p_object_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Confirming an upkeep payment records who it was for. Named or not, the
-- money itself is the whole record here — unlike Kafalat/Wazifa there is no
-- accumulating measuring-account balance to credit, because the shared
-- pool's requirement is read live from every object's own rate
-- (sadqa_upkeep_total_required) each time it is asked, not carried forward
-- as a running total.
CREATE OR REPLACE FUNCTION pool_post_confirmed_payment(
  p_pool_id uuid, p_commitment_id uuid, p_donor_name varchar, p_donor_name_ur varchar,
  p_donor_phone varchar, p_is_anonymous boolean, p_amount decimal, p_method varchar,
  p_portal_user_id uuid, p_month date, p_note text,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE pl support_pools%ROWTYPE; v_donor_id uuid; v_year varchar; v_named text;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id;

  v_named := CASE
    WHEN p_kafalat_child_id IS NOT NULL THEN
      (SELECT ' — for ' || first_name || ' (' || code || ')' FROM kafalat_children WHERE id = p_kafalat_child_id)
    WHEN p_wazifa_student_id IS NOT NULL THEN
      (SELECT ' — for ' || full_name || ' (' || code || ')' FROM wazifa_students WHERE id = p_wazifa_student_id)
    WHEN p_sadqa_object_id IS NOT NULL THEN
      (SELECT ' — for ' || item_name || ' (' || object_no || ')' FROM sadqa_objects WHERE id = p_sadqa_object_id)
    ELSE '' END;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified,
                      payment_method, is_anonymous, fund_type, portal_user_id,
                      payment_status, notes, submitted_via)
  VALUES (p_donor_name, p_donor_name_ur, p_donor_phone, p_amount,
          (now() AT TIME ZONE 'Asia/Karachi')::date, true, p_method, p_is_anonymous,
          pl.fund_type, p_portal_user_id, 'paid',
          pl.name || COALESCE(v_named, '') || ' — ' || to_char(p_month, 'Mon YYYY')
            || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  IF p_commitment_id IS NOT NULL THEN
    UPDATE pool_commitments SET status = 'active', lapsed_at = NULL, updated_at = now()
     WHERE id = p_commitment_id AND status = 'lapsed';
  END IF;

  IF pl.kind = 'kafalat' THEN
    v_year := kafalat_current_year();
    PERFORM kafalat_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_kafalat_child_id);
  ELSIF pl.kind = 'wazifa' THEN
    v_year := kafalat_current_year();
    PERFORM wazifa_post_requirement_delta(v_year, -p_amount,
      p_donor_name || ' confirmed — ' || to_char(p_month, 'Mon YYYY'), p_wazifa_student_id);
  END IF;
  -- The Sadqa upkeep pool has no measuring account to credit — its
  -- requirement is read live from every object's own rate (sadqa_upkeep_
  -- total_required), not accumulated as a ledger balance the way Kafalat and
  -- Wazifa's promises are. The donation itself, posted above, is the whole
  -- record.

  RETURN jsonb_build_object('donor_id', v_donor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION pool_post_confirmed_payment(uuid, uuid, varchar, varchar, varchar, boolean, decimal, varchar, uuid, date, text, uuid, uuid, uuid) TO authenticated;

-- pool_announce, pool_confirm_payment and pool_record_payment re-declared
-- once more to carry the sadqa_object_id target through — same shape as
-- migration 236's kafalat/wazifa additions.
CREATE OR REPLACE FUNCTION pool_announce(
  p_pool_id uuid, p_amount decimal, p_recurring boolean,
  p_funded_by varchar DEFAULT 'sadqa', p_show_name_publicly boolean DEFAULT false,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  pl support_pools%ROWTYPE; u portal_users%ROWTYPE;
  v_commitment_id uuid; v_month date; v_id uuid; v_min decimal;
BEGIN
  SELECT * INTO pl FROM support_pools WHERE id = p_pool_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool is not open.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO u FROM portal_users WHERE id = current_portal_user_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Please sign in first.' USING ERRCODE = 'P0001'; END IF;

  IF p_kafalat_child_id IS NOT NULL THEN
    IF pl.kind <> 'kafalat' THEN
      RAISE EXCEPTION 'A child can only be named on the Kafalat pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM kafalat_children WHERE id = p_kafalat_child_id AND status = 'active') THEN
      RAISE EXCEPTION 'That child is not currently active in Kafalat.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_wazifa_student_id IS NOT NULL THEN
    IF pl.kind <> 'wazifa' THEN
      RAISE EXCEPTION 'A student can only be named on the Taleemi Wazifa pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM wazifa_awards WHERE student_id = p_wazifa_student_id AND status = 'active') THEN
      RAISE EXCEPTION 'That student does not have an active award right now.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_sadqa_object_id IS NOT NULL THEN
    IF pl.code <> 'POOL-SDQ' THEN
      RAISE EXCEPTION 'An object can only be named on the shared Sadqa upkeep pool.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM sadqa_objects
                    WHERE id = p_sadqa_object_id AND maintenance_mode = 'committee'
                      AND status IN ('installed', 'in_service', 'needs_repair')) THEN
      RAISE EXCEPTION 'That object is not currently under committee-maintained upkeep.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_min := pl.min_share_pkr;
  IF p_amount < v_min THEN
    RAISE EXCEPTION 'The smallest amount for this pool is Rs %.',
      trim(to_char(v_min, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  IF p_recurring THEN
    SELECT id INTO v_commitment_id FROM pool_commitments
     WHERE pool_id = p_pool_id AND portal_user_id = u.id AND status IN ('active', 'lapsed');

    IF v_commitment_id IS NULL THEN
      INSERT INTO pool_commitments (pool_id, donor_name, donor_name_ur, donor_phone, portal_user_id,
                                    monthly_amount_pkr, funded_by, kafalat_child_id, wazifa_student_id,
                                    sadqa_object_id)
      VALUES (p_pool_id, u.full_name, u.name_ur, u.mobile, u.id, p_amount, p_funded_by,
              p_kafalat_child_id, p_wazifa_student_id, p_sadqa_object_id)
      RETURNING id INTO v_commitment_id;
    ELSE
      IF EXISTS (SELECT 1 FROM pool_commitments
                  WHERE id = v_commitment_id AND monthly_amount_pkr <> p_amount) THEN
        RAISE EXCEPTION
          'Your standing amount for this pool is already set. Change it from "My monthly shares" first if you want a different figure.'
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE pool_commitments
         SET status = 'active', lapsed_at = NULL, updated_at = now(),
             kafalat_child_id = p_kafalat_child_id, wazifa_student_id = p_wazifa_student_id,
             sadqa_object_id = p_sadqa_object_id
       WHERE id = v_commitment_id;
    END IF;
  ELSE
    v_commitment_id := NULL;
  END IF;

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, is_one_time,
                             status, announced_by_portal_user_id, announced_at, show_name_publicly,
                             kafalat_child_id, wazifa_student_id, sadqa_object_id)
  VALUES (p_pool_id, v_commitment_id, v_month, p_amount, NOT p_recurring,
          'announced', u.id, now(), p_show_name_publicly, p_kafalat_child_id, p_wazifa_student_id,
          p_sadqa_object_id)
  ON CONFLICT (commitment_id, for_month) WHERE status <> 'cancelled' AND commitment_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'This month is already announced for this pool.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('payment_id', v_id, 'commitment_id', v_commitment_id,
                            'month', v_month, 'position', pool_position(p_pool_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_announce(uuid, decimal, boolean, varchar, boolean, uuid, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION pool_confirm_payment(p_payment_id uuid, p_method varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  p pool_payments%ROWTYPE; pl support_pools%ROWTYPE;
  c pool_commitments%ROWTYPE; v_donor_name varchar; v_donor_name_ur varchar; v_donor_phone varchar;
  v_anon boolean; v_portal_user_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM pool_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF p.status <> 'announced' THEN
    RAISE EXCEPTION 'This is already %.', p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO pl FROM support_pools WHERE id = p.pool_id;

  IF p.commitment_id IS NOT NULL THEN
    SELECT * INTO c FROM pool_commitments WHERE id = p.commitment_id;
    v_donor_name := c.donor_name; v_donor_name_ur := c.donor_name_ur; v_donor_phone := c.donor_phone;
    v_anon := c.is_anonymous; v_portal_user_id := c.portal_user_id;
  ELSE
    SELECT full_name, name_ur, mobile INTO v_donor_name, v_donor_name_ur, v_donor_phone
      FROM portal_users WHERE id = p.announced_by_portal_user_id;
    v_anon := false; v_portal_user_id := p.announced_by_portal_user_id;
  END IF;

  v_posted := pool_post_confirmed_payment(p.pool_id, p.commitment_id, v_donor_name, v_donor_name_ur,
    v_donor_phone, v_anon, p.amount_pkr, COALESCE(p_method, p.method, 'bank'), v_portal_user_id,
    p.for_month, NULL, p.kafalat_child_id, p.wazifa_student_id, p.sadqa_object_id);

  UPDATE pool_payments
     SET status = 'confirmed', confirmed_at = now(), confirmed_by = current_admin_user_id(),
         donor_id = (v_posted->>'donor_id')::uuid,
         method = COALESCE(p_method, method, 'bank')
   WHERE id = p_payment_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'amount', p.amount_pkr);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION pool_record_payment(
  p_commitment_id uuid, p_amount decimal, p_method varchar,
  p_for_month date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  c pool_commitments%ROWTYPE; v_month date; v_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM pool_commitments WHERE id = p_commitment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0001'; END IF;

  v_month := COALESCE(date_trunc('month', p_for_month)::date,
                      date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date);

  v_posted := pool_post_confirmed_payment(c.pool_id, p_commitment_id, c.donor_name, c.donor_name_ur,
    c.donor_phone, c.is_anonymous, p_amount, p_method, c.portal_user_id, v_month, p_note,
    c.kafalat_child_id, c.wazifa_student_id, c.sadqa_object_id);

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method,
                             donor_id, note, created_by, status, confirmed_at, confirmed_by,
                             kafalat_child_id, wazifa_student_id, sadqa_object_id)
  VALUES (c.pool_id, p_commitment_id, v_month, p_amount, p_method,
          (v_posted->>'donor_id')::uuid, p_note, current_admin_user_id(),
          'confirmed', now(), current_admin_user_id(), c.kafalat_child_id, c.wazifa_student_id,
          c.sadqa_object_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('for_month', v_month, 'amount', p_amount,
                            'donor_id', v_posted->>'donor_id', 'payment_id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Every object currently under committee upkeep, for a donor choosing one.
CREATE OR REPLACE FUNCTION sadqa_objects_for_naming() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'object_no', o.object_no, 'item_name', o.item_name, 'item_name_ur', o.item_name_ur,
    'dedicated_to', o.dedicated_to, 'monthly_cost', sadqa_monthly_cost(o.id),
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.sadqa_object_id = o.id AND p.status = 'confirmed'
         AND p.for_month = date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date
    ), 0)
  ) ORDER BY o.object_no), '[]'::jsonb)
  FROM sadqa_objects o
 WHERE o.maintenance_mode = 'committee' AND o.status IN ('installed', 'in_service', 'needs_repair');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION sadqa_objects_for_naming() TO anon, authenticated;
