-- Phase 2, slice 3 (functions): the shop/commerce domain repeats the same
-- "admin OR owner" bug shape found in slice 2, just spread across each
-- caller inline instead of centralized in a shared helper. user_manages_shop
-- itself is NOT the problem -- it's pure ownership (shops.portal_user_id or
-- shop_staff.portal_user_id matching the caller), with no admin-bypass
-- branch, so it's already tenant-safe by construction (a portal user's own
-- id can never match a different tenant's shop). The bug is in callers that
-- OR an unscoped current_admin_permission('manage_parties') check onto an
-- unscoped row lookup: generate_customer_link_code, list_customer_links,
-- shop_remove_customer_link, shop_customer_statement,
-- shop_customers_with_balance, list_shop_staff, and -- in the same shape as
-- is_party_to_city_purchase/dispatch/negotiation from migration 579 --
-- is_party_to_shop_delivery.
--
-- admin_list_disputes and marketplace_search_demand_report are
-- admin/shop-owner-gated aggregate reads with no tenant filter inside the
-- query itself -- same bug class, different shape (the auth check passes,
-- then the actual SELECT reads every tenant's rows). admin_marketplace_overview
-- is the worst instance of this: six unioned income sources, wallet
-- balances, advance-held and pending-topup counts, all aggregated with zero
-- tenant filtering -- an admin dashboard that mixed every tenant's activity
-- into one number.
--
-- ensure_shop_account has the exact bug ensure_vehicle_account had (fixed
-- in migration 580): its INSERT INTO accounts relied on the column's
-- auth-context DEFAULT instead of the shop's own tenant_id.
--
-- search_marketplace_products, shop_bookable, shop_open_now and
-- shop_popular_products are public, pre-login shop-browsing helpers with no
-- tenant filter at all -- shop_bookable/shop_open_now/shop_popular_products
-- specifically need the coalesce(...) fallback (not plain my_tenant_id())
-- because search_marketplace_products calls them with no auth context, and
-- a plain my_tenant_id() there would make every shop look closed/
-- unbookable to an anonymous browser.
--
-- trg_collector_settlement_ledger's ledger_entries inserts now carry
-- NEW.tenant_id explicitly (collector_settlements already has tenant_id
-- from phase 1) for the same defense-in-depth reason as the phase 1 audit
-- triggers, even though the account ids it inserts against are already
-- correctly tenant-scoped once ensure_shop_account/ensure_vehicle_account
-- are fixed.
--
-- Left unchanged (already safely self-scoped by ownership with no
-- admin-bypass branch, so no fix needed): delete_shop_deal, delete_shop_kit,
-- edit_shop_sale, my_credit_accounts, place_shop_wallet_topup,
-- record_shop_credit_payment, record_shop_purchase, record_shop_sale,
-- redeem_customer_link_code (a short-lived single-use secret code, not an
-- id lookup -- the tenant boundary is enforced by the code's own secrecy,
-- same as any OTP), save_shop_deal, save_shop_kit, submit_catalog_brand,
-- toggle_shop_deal, unlink_customer_portal, unlink_shared_customer_link,
-- shop_best_sellers, shop_daily_earnings, shop_dashboard_summary,
-- my_shop_delivery_invitations, advance_shop_delivery_ring,
-- decline_shop_delivery, file_dispute, generate_shop_customer_invoice,
-- vehicle_dashboard_summary, vehicle_today_ledger, user_manages_shop.

create or replace function public.is_party_to_shop_delivery(p_order_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM shop_orders o
    WHERE o.id = p_order_id AND o.tenant_id = my_tenant_id()
      AND (COALESCE(current_admin_permission('manage_parties'), false)
           OR o.portal_user_id = current_portal_user_id()
           OR user_manages_shop(o.shop_id))
  ) OR EXISTS (
    SELECT 1 FROM shop_delivery_invitations i JOIN vehicles v ON v.id = i.vehicle_id
    WHERE i.order_id = p_order_id AND i.tenant_id = my_tenant_id() AND v.portal_user_id = current_portal_user_id()
  );
$function$;

create or replace function public.generate_customer_link_code(p_customer_id uuid)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_shop_id uuid;
  v_linked_count int;
  v_code text;
  v_tries int := 0;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id AND tenant_id = my_tenant_id();
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;

  SELECT COUNT(*) INTO v_linked_count FROM shop_customer_links WHERE customer_id = p_customer_id;
  IF v_linked_count >= 6 THEN
    RAISE EXCEPTION 'This account already has the maximum of 6 linked portal users.';
  END IF;

  DELETE FROM shop_customer_link_codes WHERE customer_id = p_customer_id AND used_at IS NULL;

  LOOP
    v_code := lpad(floor(random() * 1000000)::int::text, 6, '0');
    BEGIN
      INSERT INTO shop_customer_link_codes (customer_id, code, created_by, expires_at)
      VALUES (p_customer_id, v_code, v_portal_user_id, now() + interval '30 minutes');
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_tries := v_tries + 1;
      IF v_tries > 5 THEN RAISE EXCEPTION 'Could not generate a code, please try again.'; END IF;
    END;
  END LOOP;

  RETURN v_code;
END;
$function$;

create or replace function public.list_customer_links(p_customer_id uuid)
 returns TABLE(link_id uuid, label text, linked_at timestamp with time zone)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT shop_id INTO v_shop_id FROM shop_customers WHERE id = p_customer_id AND tenant_id = my_tenant_id();
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this customer''s shop.';
  END IF;
  RETURN QUERY SELECT l.id, l.label, l.linked_at FROM shop_customer_links l WHERE l.customer_id = p_customer_id ORDER BY l.label;
END;
$function$;

create or replace function public.shop_remove_customer_link(p_link_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_shop_id uuid;
BEGIN
  SELECT c.shop_id INTO v_shop_id FROM shop_customer_links l JOIN shop_customers c ON c.id = l.customer_id WHERE l.id = p_link_id AND l.tenant_id = my_tenant_id();
  IF v_shop_id IS NULL OR NOT (current_admin_permission('manage_parties') OR user_manages_shop(v_shop_id)) THEN
    RAISE EXCEPTION 'You do not manage this account.';
  END IF;
  DELETE FROM shop_customer_links WHERE id = p_link_id;
END;
$function$;

create or replace function public.shop_customer_statement(p_customer_id uuid)
 returns TABLE(entry_id uuid, entry_type text, entry_at timestamp with time zone, description text, debit numeric, credit numeric, running_balance numeric)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM shop_customers c
    WHERE c.id = p_customer_id AND c.tenant_id = my_tenant_id() AND (
      current_admin_permission('manage_parties') OR user_manages_shop(c.shop_id)
      OR EXISTS (SELECT 1 FROM shop_customer_links l WHERE l.customer_id = c.id AND l.portal_user_id = current_portal_user_id())
    )
  ) THEN
    RAISE EXCEPTION 'You cannot view this customer''s statement.';
  END IF;

  RETURN QUERY
  WITH entries AS (
    SELECT sa.id AS e_id, 'sale'::text AS e_type, sa.created_at AS e_at,
      'Sale #' || substr(sa.id::text, 1, 8) AS e_description, sa.total_amount_pkr AS e_debit, 0::decimal AS e_credit
    FROM shop_sales sa WHERE sa.customer_id = p_customer_id
    UNION ALL
    SELECT pmt.id, 'payment', pmt.created_at, COALESCE(pmt.note, 'Payment received'), 0::decimal, pmt.amount_pkr
    FROM shop_customer_payments pmt WHERE pmt.customer_id = p_customer_id
    UNION ALL
    SELECT inv.id, 'invoice', inv.created_at, 'Invoice #' || inv.invoice_number || ' generated', 0::decimal, 0::decimal
    FROM shop_customer_invoices inv WHERE inv.customer_id = p_customer_id
  )
  SELECT entries.e_id, entries.e_type, entries.e_at, entries.e_description, entries.e_debit, entries.e_credit,
    SUM(entries.e_debit - entries.e_credit) OVER (ORDER BY entries.e_at, entries.e_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_balance
  FROM entries
  ORDER BY entries.e_at DESC, entries.e_id DESC;
END;
$function$;

create or replace function public.shop_customers_with_balance(p_shop_id uuid)
 returns TABLE(id uuid, name text, name_ur text, phone text, is_active boolean, balance numeric, linked_count integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.tenant_id = my_tenant_id() AND (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id))) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.name_ur, c.phone, c.is_active,
    COALESCE((SELECT SUM(sa.total_amount_pkr) FROM shop_sales sa WHERE sa.customer_id = c.id), 0)
    - COALESCE((SELECT SUM(pmt.amount_pkr) FROM shop_customer_payments pmt WHERE pmt.customer_id = c.id), 0) AS balance,
    (SELECT COUNT(*)::int FROM shop_customer_links l WHERE l.customer_id = c.id) AS linked_count
  FROM shop_customers c
  WHERE c.shop_id = p_shop_id
  ORDER BY c.name;
END;
$function$;

create or replace function public.list_shop_staff(p_shop_id uuid)
 returns TABLE(id uuid, portal_user_id uuid, full_name text, mobile text, added_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shops s WHERE s.id = p_shop_id AND s.tenant_id = my_tenant_id() AND (current_admin_permission('manage_parties') OR user_manages_shop(p_shop_id))) THEN
    RAISE EXCEPTION 'You do not manage this shop.';
  END IF;
  RETURN QUERY
  SELECT st.id, st.portal_user_id, pu.full_name::text, pu.mobile::text, st.added_at
  FROM shop_staff st JOIN portal_users pu ON pu.id = st.portal_user_id
  WHERE st.shop_id = p_shop_id
  ORDER BY st.added_at;
END;
$function$;

create or replace function public.admin_list_disputes(p_status character varying DEFAULT 'open'::character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_result jsonb;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'created_at') DESC), '[]'::jsonb) INTO v_result FROM (
    SELECT jsonb_build_object(
      'id', d.id, 'kind', d.kind, 'ref_type', d.ref_type, 'ref_id', d.ref_id,
      'claimed_amount_pkr', d.claimed_amount_pkr, 'agreed_amount_pkr', d.agreed_amount_pkr,
      'note', d.note, 'status', d.status, 'ruling', d.ruling, 'resolution_note', d.resolution_note,
      'created_at', d.created_at, 'resolved_at', d.resolved_at,
      'filed_by_name', pu.full_name, 'filed_by_mobile', pu.mobile,
      'ref_summary', CASE d.ref_type
        WHEN 'shop_order' THEN (SELECT jsonb_build_object('shop_name', s.name, 'vehicle_owner', v.owner_name) FROM shop_orders o LEFT JOIN shops s ON s.id = o.shop_id LEFT JOIN vehicles v ON v.id = o.delivery_vehicle_id WHERE o.id = d.ref_id)
        WHEN 'hourly_booking' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'hours', b.hours) FROM hourly_bookings b LEFT JOIN vehicles v ON v.id = b.vehicle_id WHERE b.id = d.ref_id)
        WHEN 'shadi_request' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'event_date', e.event_date) FROM shadi_vehicle_requests r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN shadi_events e ON e.id = r.event_id WHERE r.id = d.ref_id)
        WHEN 'trip_offer' THEN (SELECT jsonb_build_object('vehicle_owner', v.owner_name, 'origin', o.origin, 'destination', o.destination) FROM vehicle_trip_offers o LEFT JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = d.ref_id)
        ELSE NULL
      END
    ) AS row
    FROM disputes d
    LEFT JOIN portal_users pu ON pu.id = d.filed_by_portal_user_id
    WHERE d.tenant_id = my_tenant_id() AND (p_status IS NULL OR d.status = p_status)
    LIMIT 200
  ) rows;

  RETURN v_result;
END;
$function$;

create or replace function public.admin_marketplace_overview()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Karachi')::date;
  v_tenant uuid;
  v_jobs_today int; v_cash_today decimal;
  v_vehicles_live int;
  v_wallets_negative_count int; v_wallets_negative_total decimal;
  v_advance_held decimal;
  v_pending_topups int; v_pending_shadi_advance int; v_open_disputes int;
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;
  v_tenant := my_tenant_id();

  -- Same six income sources vehicle_dashboard_summary (488) sums per
  -- vehicle, here summed across all of them for "today's activity."
  WITH jobs AS (
    SELECT b.total_amount_pkr AS amount, b.confirmed_at AT TIME ZONE 'Asia/Karachi' AS at
    FROM ride_bookings b WHERE b.status = 'confirmed' AND b.tenant_id = v_tenant
    UNION ALL
    SELECT b.total_amount_pkr, b.completed_at AT TIME ZONE 'Asia/Karachi' FROM vehicle_trip_bookings b WHERE b.status = 'completed' AND b.completed_at IS NOT NULL AND b.tenant_id = v_tenant
    UNION ALL
    SELECT coalesce(b.total_amount_pkr, b.base_amount_pkr), b.ended_at AT TIME ZONE 'Asia/Karachi' FROM hourly_bookings b WHERE b.status_confirmed AND b.ended_at IS NOT NULL AND b.tenant_id = v_tenant
    UNION ALL
    SELECT sr.advance_share_pkr, sr.paid_out_at AT TIME ZONE 'Asia/Karachi' FROM shadi_vehicle_requests sr WHERE sr.payout_voucher_id IS NOT NULL AND sr.paid_out_at IS NOT NULL AND sr.tenant_id = v_tenant
    UNION ALL
    SELECT o.delivery_fee_pkr, o.delivered_at AT TIME ZONE 'Asia/Karachi' FROM shop_orders o WHERE o.fulfillment_status = 'delivered' AND o.delivered_at IS NOT NULL AND o.tenant_id = v_tenant
    UNION ALL
    SELECT GREATEST(0, coalesce(c.total_pkr, 0) - coalesce(c.goods_budget_pkr, 0)), c.completed_at AT TIME ZONE 'Asia/Karachi' FROM dispatch_calls c WHERE c.status = 'completed' AND c.completed_at IS NOT NULL AND c.tenant_id = v_tenant
  )
  SELECT COUNT(*) FILTER (WHERE at::date = v_today), COALESCE(SUM(amount) FILTER (WHERE at::date = v_today), 0)
  INTO v_jobs_today, v_cash_today FROM jobs;

  SELECT jsonb_array_length(admin_fleet_locations()) INTO v_vehicles_live;

  SELECT count(*), COALESCE(SUM(-bal), 0) INTO v_wallets_negative_count, v_wallets_negative_total FROM (
    SELECT seller_account_balance(a.id) AS bal FROM accounts a WHERE a.vehicle_id IS NOT NULL AND a.tenant_id = v_tenant
  ) x WHERE bal < 0;

  SELECT COALESCE(SUM(sr.advance_share_pkr), 0) INTO v_advance_held
  FROM shadi_vehicle_requests sr JOIN shadi_events se ON se.id = sr.event_id
  WHERE sr.status = 'accepted' AND se.status = 'confirmed' AND sr.payout_voucher_id IS NULL AND sr.advance_share_pkr IS NOT NULL AND sr.tenant_id = v_tenant;

  SELECT count(*) INTO v_pending_topups FROM (
    SELECT id FROM vehicle_wallet_topups WHERE status = 'announced' AND tenant_id = v_tenant
    UNION ALL SELECT id FROM shop_wallet_topups WHERE status = 'announced' AND tenant_id = v_tenant
  ) x;

  SELECT count(*) INTO v_pending_shadi_advance FROM shadi_events WHERE status = 'advance_announced' AND tenant_id = v_tenant;
  SELECT count(*) INTO v_open_disputes FROM disputes WHERE status = 'open' AND tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'jobs_today', v_jobs_today, 'cash_today_pkr', v_cash_today, 'vehicles_live', v_vehicles_live,
    'wallets_negative_count', v_wallets_negative_count, 'wallets_negative_total_pkr', v_wallets_negative_total,
    'advance_held_pkr', v_advance_held,
    'needs_action', jsonb_build_object(
      'pending_wallet_topups', v_pending_topups, 'pending_shadi_advance', v_pending_shadi_advance, 'open_disputes', v_open_disputes
    )
  );
END;
$function$;

create or replace function public.marketplace_search_demand_report(p_days integer DEFAULT 30)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_authorized boolean := false;
BEGIN
  IF COALESCE(current_admin_permission('manage_parties'), false) THEN v_authorized := true; END IF;
  IF NOT v_authorized AND EXISTS (
    SELECT 1 FROM shops WHERE portal_user_id = current_portal_user_id() AND commission_mode = 'monthly_lumpsum'
  ) THEN v_authorized := true; END IF;
  IF NOT v_authorized THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object(
    'matched', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT query, count(*) AS searches FROM marketplace_search_log
      WHERE searched_at >= now() - (p_days || ' days')::interval AND result_count > 0 AND tenant_id = my_tenant_id()
      GROUP BY query ORDER BY count(*) DESC LIMIT 20
    ) x),
    'unmatched', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
      SELECT query, count(*) AS searches FROM marketplace_search_log
      WHERE searched_at >= now() - (p_days || ' days')::interval AND result_count = 0 AND tenant_id = my_tenant_id()
      GROUP BY query ORDER BY count(*) DESC LIMIT 20
    ) x)
  );
END;
$function$;

create or replace function public.ensure_shop_account(p_shop_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_name varchar;
  v_tenant_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE shop_id = p_shop_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT name, tenant_id INTO v_name, v_tenant_id FROM shops WHERE id = p_shop_id;
  INSERT INTO accounts (code, name, type, system, shop_id, opening_balance, tenant_id)
  VALUES ('SHP-' || substr(replace(p_shop_id::text, '-', ''), 1, 8), v_name, 'shop', 'donors_projects', p_shop_id, 0, v_tenant_id)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$function$;

create or replace function public.search_marketplace_products(p_query text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_results jsonb;
  v_count int;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_name_ur', p.name_ur,
    'flavor', p.flavor, 'flavor_ur', p.flavor_ur, 'unit_price_pkr', p.unit_price_pkr,
    'shop_id', s.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
    'shop_location', s.location, 'shop_location_ur', s.location_ur,
    'delivery_enabled', s.delivery_enabled, 'bookable', shop_bookable(s.id)
  ) ORDER BY p.unit_price_pkr), '[]'::jsonb), count(*)
  INTO v_results, v_count
  FROM shop_products p
  JOIN shops s ON s.id = p.shop_id
  WHERE p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND p.is_active AND s.status = 'active'
    AND (p.name ILIKE '%' || p_query || '%' OR p.name_ur ILIKE '%' || p_query || '%'
      OR p.flavor ILIKE '%' || p_query || '%' OR p.flavor_ur ILIKE '%' || p_query || '%');

  IF trim(p_query) <> '' THEN
    INSERT INTO marketplace_search_log (query, result_count) VALUES (trim(p_query), v_count);
  END IF;

  RETURN v_results;
END;
$function$;

create or replace function public.shop_bookable(p_shop_id uuid)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_shop shops%ROWTYPE; v_min decimal; v_now_time time; v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id AND tenant_id = v_tenant;
  IF NOT FOUND OR v_shop.status <> 'active' OR NOT v_shop.delivery_enabled THEN RETURN false; END IF;

  IF v_shop.opens_at IS NOT NULL AND v_shop.closes_at IS NOT NULL THEN
    v_now_time := (now() AT TIME ZONE 'Asia/Karachi')::time;
    IF v_now_time < v_shop.opens_at OR v_now_time > v_shop.closes_at THEN RETURN false; END IF;
  END IF;

  IF v_shop.commission_mode = 'monthly_lumpsum' THEN RETURN true; END IF;
  SELECT COALESCE(value::decimal, 0) INTO v_min FROM site_settings WHERE key = 'marketplace_min_balance_to_order_pkr' AND tenant_id = v_tenant;
  RETURN seller_account_balance(ensure_shop_account(p_shop_id)) >= v_min;
END;
$function$;

create or replace function public.shop_open_now(p_shop_id uuid)
 returns boolean
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_opens time; v_closes time; v_now_time time;
BEGIN
  SELECT opens_at, closes_at INTO v_opens, v_closes FROM shops WHERE id = p_shop_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF v_opens IS NULL OR v_closes IS NULL THEN RETURN true; END IF;
  v_now_time := (now() AT TIME ZONE 'Asia/Karachi')::time;
  RETURN v_now_time >= v_opens AND v_now_time <= v_closes;
END;
$function$;

create or replace function public.shop_popular_products(p_shop_id uuid, p_days integer DEFAULT 30, p_limit integer DEFAULT 8)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_shop shops%ROWTYPE;
BEGIN
  SELECT * INTO v_shop FROM shops WHERE id = p_shop_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF NOT FOUND OR v_shop.status <> 'active' THEN RETURN '[]'::jsonb; END IF;

  RETURN (
    WITH combined AS (
      SELECT si.product_id, SUM(si.quantity) AS qty
      FROM shop_sale_items si JOIN shop_sales sa ON sa.id = si.sale_id
      WHERE sa.shop_id = p_shop_id AND sa.created_at >= now() - (p_days || ' days')::interval
      GROUP BY si.product_id
      UNION ALL
      SELECT oi.product_id, SUM(oi.quantity)
      FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
      WHERE o.shop_id = p_shop_id AND o.status = 'confirmed' AND o.confirmed_at >= now() - (p_days || ' days')::interval
      GROUP BY oi.product_id
    ), totals AS (
      SELECT product_id, SUM(qty) AS total_qty FROM combined WHERE product_id IS NOT NULL GROUP BY product_id
    )
    SELECT COALESCE(jsonb_agg(t.product_id ORDER BY t.total_qty DESC), '[]'::jsonb)
    FROM (SELECT product_id, total_qty FROM totals ORDER BY total_qty DESC LIMIT p_limit) t
  );
END;
$function$;

create or replace function public.trg_collector_settlement_ledger()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_clearing_account_id uuid;
  v_owner_name varchar;
  v_particular text;
BEGIN
  IF NEW.collector_id IS NOT NULL THEN
    v_clearing_account_id := ensure_collector_account(NEW.collector_id, NEW.system);
    SELECT full_name INTO v_owner_name FROM admin_users WHERE id = NEW.collector_id;
    v_particular := 'Cash received from collector ' || COALESCE(v_owner_name, 'Unknown');
  ELSIF NEW.shop_id IS NOT NULL THEN
    v_clearing_account_id := ensure_shop_account(NEW.shop_id);
    SELECT name INTO v_owner_name FROM shops WHERE id = NEW.shop_id;
    v_particular := 'Paid out to shop ' || COALESCE(v_owner_name, 'Unknown');
  ELSE
    v_clearing_account_id := ensure_vehicle_account(NEW.vehicle_id);
    SELECT owner_name INTO v_owner_name FROM vehicles WHERE id = NEW.vehicle_id;
    v_particular := 'Paid out to vehicle owner ' || COALESCE(v_owner_name, 'Unknown');
  END IF;
  v_particular := v_particular || CASE WHEN NEW.note IS NOT NULL AND trim(NEW.note) != '' THEN ' — ' || NEW.note ELSE '' END;

  -- A collector settlement is money coming IN (debit real cash/bank,
  -- credit their clearing account down to zero). A shop/vehicle
  -- settlement is money going OUT (the committee paying the owner what's
  -- owed) — the legs are the reverse of that.
  IF NEW.collector_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, tenant_id)
    VALUES (NEW.to_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id, NEW.tenant_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, tenant_id)
    VALUES (v_clearing_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id, NEW.tenant_id);
  ELSE
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, tenant_id)
    VALUES (v_clearing_account_id, NEW.settled_date, v_particular, NEW.amount_pkr, 0, 'collector_settlement', NEW.id, NEW.tenant_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, tenant_id)
    VALUES (NEW.to_account_id, NEW.settled_date, v_particular, 0, NEW.amount_pkr, 'collector_settlement', NEW.id, NEW.tenant_id);
  END IF;

  RETURN NEW;
END;
$function$;
