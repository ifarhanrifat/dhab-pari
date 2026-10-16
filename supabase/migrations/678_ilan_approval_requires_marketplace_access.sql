-- Migration 678: committee_approve_ilan/committee_reject_ilan (677)
-- only checked the tenant-level can_access_system('marketplace') and
-- the generic manage_parties permission -- that would let ANY admin
-- with manage_parties approve ilans, regardless of whether they
-- personally have Marketplace access (the marketplace_accountant role
-- or the accountant+access_marketplace combination from migration
-- 675). Add the missing per-admin check so the two systems agree.

CREATE OR REPLACE FUNCTION public.committee_approve_ilan(
  p_ilan_id uuid,
  p_edited_title_ur varchar DEFAULT NULL,
  p_edited_body_ur text DEFAULT NULL,
  p_edited_title_en varchar DEFAULT NULL,
  p_edited_body_en text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ilan commercial_ilans%rowtype;
  v_admin_id uuid := current_admin_user_id();
  v_cash_account uuid;
  v_revenue_account uuid;
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace')
     OR NOT admin_user_can_access_system(v_admin_id, 'marketplace')
     OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to approve ilans';
  END IF;

  SELECT * INTO ilan FROM commercial_ilans WHERE id = p_ilan_id AND home_tenant_id = my_tenant_id() AND status = 'pending_approval' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan not found or not pending approval';
  END IF;

  IF NOT ilan.is_auto_generated THEN
    UPDATE commercial_ilans SET
      title_ur = COALESCE(NULLIF(trim(p_edited_title_ur), ''), title_ur),
      body_ur = COALESCE(NULLIF(trim(p_edited_body_ur), ''), body_ur),
      title_en = COALESCE(NULLIF(trim(p_edited_title_en), ''), title_en),
      body_en = COALESCE(NULLIF(trim(p_edited_body_en), ''), body_en)
    WHERE id = p_ilan_id;
  END IF;

  UPDATE commercial_ilans SET status = 'approved', reviewed_by = v_admin_id, reviewed_at = now()
   WHERE id = p_ilan_id;

  IF ilan.price_pkr > 0 THEN
    v_revenue_account := ensure_ilan_revenue_account(ilan.home_tenant_id);
    SELECT id INTO v_cash_account FROM accounts WHERE system = 'marketplace' AND code = 'MKT-1001' AND tenant_id = ilan.home_tenant_id;
    IF v_cash_account IS NOT NULL THEN
      INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr, from_account_id, to_account_id)
      VALUES ('marketplace', 'income', (now() AT TIME ZONE 'Asia/Karachi')::date,
        'Cash received for ilan — ' || ilan.title_ur, ilan.price_pkr, v_revenue_account, v_cash_account);
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.committee_reject_ilan(p_ilan_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin_id uuid := current_admin_user_id();
BEGIN
  IF v_admin_id IS NULL OR NOT can_access_system('marketplace')
     OR NOT admin_user_can_access_system(v_admin_id, 'marketplace')
     OR NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'You do not have permission to review ilans';
  END IF;
  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = p_reason, reviewed_by = v_admin_id, reviewed_at = now()
   WHERE id = p_ilan_id AND home_tenant_id = my_tenant_id() AND status = 'pending_approval';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan not found or not pending approval';
  END IF;
END;
$$;

-- Same gap on the read side -- a manage_parties admin with no
-- Marketplace access shouldn't see these rows in their admin UI either.
DROP POLICY IF EXISTS commercial_ilans_committee_read ON commercial_ilans;
CREATE POLICY commercial_ilans_committee_read ON commercial_ilans
  FOR SELECT TO authenticated
  USING (
    home_tenant_id = my_tenant_id()
    AND can_access_system('marketplace')
    AND admin_user_can_access_system(current_admin_user_id(), 'marketplace')
  );
