-- Migration 239: one path for money into the system, not two.
--
-- pool_record_payment() (migration 222) let an accountant type in a payment
-- for an existing recurring commitment with no receipt and no announcement —
-- a second way for a transaction to appear beside announce -> confirm. It is
-- retired outright, not just unlinked from the UI, so there is no way back
-- into it by accident.
--
-- What replaces it for a walk-in donor who has no portal account at all: the
-- accountant searches for them by name/phone first (never a second account
-- for the same person), creates one if genuinely new, then receives the cash
-- against it — always one-time, never a standing recurring commitment, and
-- posted through the exact same pool_post_confirmed_payment() every other
-- confirmed pool donation uses, so it gets a real voucher, a real ledger
-- entry, and correctly reduces whichever measuring account it belongs to.

DROP FUNCTION IF EXISTS pool_record_payment(uuid, decimal, varchar, date, text);

-- ═════════════════════════════════════════════════════════════════════════
-- Search first — never a second account for the same person
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION admin_search_donor_accounts(p_query varchar) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', id, 'full_name', full_name, 'mobile', mobile,
    'father_husband_name', father_husband_name, 'whatsapp_number', whatsapp_number,
    'has_login', auth_user_id IS NOT NULL
  ) ORDER BY full_name), '[]'::jsonb)
  FROM portal_users
  WHERE is_active
    AND (full_name ILIKE '%' || p_query || '%' OR mobile ILIKE '%' || p_query || '%')
  LIMIT 15;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_search_donor_accounts(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_search_donor_accounts(varchar) TO authenticated;

-- Only reached once a search has come back empty. Left unclaimed
-- (auth_user_id NULL) — this is the same shape a self-signup produces,
-- except nobody has logged into it yet. If this same person later signs up
-- themselves with this mobile number, the portal signup route recognises the
-- match and claims this row instead of creating a second one.
CREATE OR REPLACE FUNCTION admin_create_donor_account(
  p_full_name varchar, p_mobile varchar, p_father_husband_name varchar DEFAULT NULL,
  p_whatsapp_number varchar DEFAULT NULL, p_name_ur varchar DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_full_name), '') = '' OR COALESCE(trim(p_mobile), '') = '' THEN
    RAISE EXCEPTION 'A name and a mobile number are both needed.' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM portal_users WHERE lower(trim(mobile)) = lower(trim(p_mobile))) THEN
    RAISE EXCEPTION 'An account with this mobile number already exists — search for it instead of creating a new one.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO portal_users (full_name, name_ur, mobile, father_husband_name, whatsapp_number)
  VALUES (trim(p_full_name), p_name_ur, trim(p_mobile), p_father_husband_name, p_whatsapp_number)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_create_donor_account(varchar, varchar, varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_create_donor_account(varchar, varchar, varchar, varchar, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- Receiving cash for Kafalat, Wazifa or the shared Sadqa upkeep pool
-- ═════════════════════════════════════════════════════════════════════════
-- Always one-time. A donor who wants this every month uses the portal
-- themselves and becomes a real recurring commitment; a village elder who
-- handed over cash once today did not just agree to pay every month forever.
CREATE OR REPLACE FUNCTION admin_receive_program_cash(
  p_portal_user_id uuid, p_pool_code varchar, p_amount decimal, p_method varchar,
  p_kafalat_child_id uuid DEFAULT NULL, p_wazifa_student_id uuid DEFAULT NULL,
  p_sadqa_object_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  u portal_users%ROWTYPE; pl support_pools%ROWTYPE; v_month date; v_id uuid; v_posted jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_pool_code NOT IN ('POOL-KFL', 'POOL-WZF', 'POOL-SDQ') THEN
    RAISE EXCEPTION 'Not a recognised programme.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'The amount must be more than zero.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO u FROM portal_users WHERE id = p_portal_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That donor account was not found.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO pl FROM support_pools WHERE code = p_pool_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'That pool does not exist yet.' USING ERRCODE = 'P0001'; END IF;

  v_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Karachi')::date)::date;

  v_posted := pool_post_confirmed_payment(pl.id, NULL, u.full_name, u.name_ur, u.mobile, false,
    p_amount, p_method, u.id, v_month, p_note,
    p_kafalat_child_id, p_wazifa_student_id, p_sadqa_object_id);

  INSERT INTO pool_payments (pool_id, commitment_id, for_month, amount_pkr, method, is_one_time,
                             donor_id, note, created_by, status, confirmed_at, confirmed_by,
                             kafalat_child_id, wazifa_student_id, sadqa_object_id)
  VALUES (pl.id, NULL, v_month, p_amount, p_method, true,
          (v_posted->>'donor_id')::uuid, p_note, current_admin_user_id(),
          'confirmed', now(), current_admin_user_id(), p_kafalat_child_id, p_wazifa_student_id,
          p_sadqa_object_id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('donor_id', v_posted->>'donor_id', 'payment_id', v_id, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION admin_receive_program_cash(uuid, varchar, decimal, varchar, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_receive_program_cash(uuid, varchar, decimal, varchar, uuid, uuid, uuid, text) TO authenticated;
