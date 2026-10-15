-- Migration 671: the commercial ilan/advertising system.
--
-- Explicit design, per direct instruction: this is run entirely by the
-- platform team, not village committees. "Separate account, separate
-- users, separate cash flow, separate cash accounts, separate reporting"
-- -- so this does NOT reuse the tenant-scoped accounts/ledger_entries
-- double-entry system (that's per-village and keyed to admin_users
-- collectors; a platform_admin has no tenant_id to hang it off of
-- anyway). Instead it gets its own small platform-level mirror of the
-- proven "cash held in their name until settled" collector pattern
-- (migrations 057/119), scoped to platform_admins instead of
-- admin_users.
--
-- Free content (emergency/news/appeal/ilaan) stays exactly as already
-- shipped in migration 670/the existing appeals system -- untouched by
-- this migration. This is the PAID layer only: a commercial advertiser
-- (someone who already owns a vehicle in the marketplace) requests a
-- paid ticker or banner placement, a platform admin reviews and
-- approves it (collecting the cash in person at that moment, which
-- marks that admin as now holding/owing that cash to the platform),
-- and it displays for the bought window across the villages it
-- targeted.

-- ===================== Plan gating =====================
-- Same shape as water_supply_enabled/donors_enabled (628): a plan
-- declares whether it includes this module, platform_subscribe_tenant
-- copies that onto the tenant's own live flag, can_access_system() reads
-- the tenant's live flag. A tenant must have this enabled both to let
-- its own vehicle owners buy ilans AND to be a legal ad target at all.

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS includes_commercial_ilans boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS commercial_ilans_enabled boolean NOT NULL DEFAULT false;

-- Reproduced from its real, current body (pulled live via
-- pg_get_functiondef) with one added WHEN arm -- every other arm is
-- untouched.
CREATE OR REPLACE FUNCTION public.can_access_system(p_system character varying)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := my_tenant_id();
  v_enabled boolean;
begin
  if v_tenant_id is null then
    return false;
  end if;
  select case p_system
    when 'water_supply' then t.water_supply_enabled
    when 'donors_projects' then t.donors_enabled
    when 'commercial_ilans' then t.commercial_ilans_enabled
    else true
  end into v_enabled
  from tenants t where t.id = v_tenant_id;
  return coalesce(v_enabled, true);
end;
$function$;

-- Reproduced from its real, current body, with one added UPDATE column
-- -- every other line is untouched.
CREATE OR REPLACE FUNCTION public.platform_subscribe_tenant(p_tenant_id uuid, p_plan_id uuid, p_billing_cycle character varying DEFAULT 'monthly'::character varying, p_trial_days integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_period_end date; v_plan subscription_plans%rowtype; v_status varchar; v_actor_id uuid; v_actor_name varchar;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'Tenant not found';
  END IF;
  SELECT * INTO v_plan FROM subscription_plans WHERE id = p_plan_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Plan not found or inactive';
  END IF;

  UPDATE tenant_subscriptions SET status = 'cancelled', cancel_at_period_end = false, updated_at = now()
   WHERE tenant_id = p_tenant_id AND status IN ('trialing', 'active', 'past_due');

  IF p_trial_days IS NOT NULL AND p_trial_days > 0 THEN
    v_status := 'trialing';
    v_period_end := (current_date + (p_trial_days || ' days')::interval)::date;
  ELSE
    v_status := 'active';
    v_period_end := CASE p_billing_cycle WHEN 'annual' THEN (current_date + interval '1 year')::date ELSE (current_date + interval '1 month')::date END;
  END IF;

  INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_start, current_period_end)
  VALUES (p_tenant_id, p_plan_id, v_status, p_billing_cycle, current_date, v_period_end)
  RETURNING id INTO v_id;

  UPDATE tenants SET water_supply_enabled = v_plan.includes_water_supply, donors_enabled = v_plan.includes_donors_projects,
    commercial_ilans_enabled = v_plan.includes_commercial_ilans
   WHERE id = p_tenant_id;

  PERFORM seed_default_chart_of_accounts(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);
  PERFORM seed_voucher_counters(p_tenant_id, v_plan.includes_water_supply, v_plan.includes_donors_projects);

  v_actor_id := current_platform_admin_id();
  SELECT full_name INTO v_actor_name FROM platform_admins WHERE id = v_actor_id;
  INSERT INTO platform_audit_log (actor_platform_admin_id, actor_name, action, target_tenant_id, details)
  VALUES (v_actor_id, v_actor_name, 'tenant_subscribed', p_tenant_id, jsonb_build_object('plan', v_plan.name, 'status', v_status, 'billing_cycle', p_billing_cycle, 'trial_days', p_trial_days));

  RETURN v_id;
END;
$function$;

-- ===================== Rate card =====================

CREATE TABLE ilan_rate_cards (
  id uuid primary key default gen_random_uuid(),
  placement varchar not null check (placement in ('ticker', 'banner')),
  price_per_village_per_day_pkr decimal not null check (price_per_village_per_day_pkr > 0),
  min_hours int not null default 3 check (min_hours > 0),
  max_days int not null default 30 check (max_days > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

ALTER TABLE ilan_rate_cards ENABLE ROW LEVEL SECURITY;

-- Everyone who might need to quote a campaign (any portal_user) reads
-- the live card; only platform admins can version it.
CREATE POLICY ilan_rate_cards_read ON ilan_rate_cards
  FOR SELECT TO authenticated
  USING (is_active = true OR is_platform_admin());

CREATE POLICY ilan_rate_cards_manage ON ilan_rate_cards
  FOR ALL TO authenticated
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- ===================== Platform-level collector ledger =====================
-- Deliberately not the tenant-scoped accounts/ledger_entries system --
-- see the migration header. A platform admin's held balance is just
-- SUM(credit) - SUM(debit) over their own rows here.

CREATE TABLE platform_ilan_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references platform_admins(id),
  entry_date date not null default current_date,
  particular text not null,
  debit decimal not null default 0 check (debit >= 0),
  credit decimal not null default 0 check (credit >= 0),
  reference_type varchar not null,
  reference_id uuid,
  created_at timestamptz not null default now()
);

ALTER TABLE platform_ilan_ledger_entries ENABLE ROW LEVEL SECURITY;

-- Small central team, full mutual visibility -- same trust model
-- platform_admins already has everywhere else. Writes only via the
-- RPCs/trigger below, never direct.
CREATE POLICY platform_ilan_ledger_read ON platform_ilan_ledger_entries
  FOR SELECT TO authenticated
  USING (is_platform_admin());

CREATE TABLE platform_ilan_settlements (
  id uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references platform_admins(id),
  amount_pkr decimal not null check (amount_pkr > 0),
  settled_date date not null default current_date,
  note text,
  recorded_by uuid not null references platform_admins(id),
  created_at timestamptz not null default now()
);

ALTER TABLE platform_ilan_settlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY platform_ilan_settlements_read ON platform_ilan_settlements
  FOR SELECT TO authenticated
  USING (is_platform_admin());

-- Same shape as trg_collector_settlement_ledger (119): a settlement row
-- posts one debit entry that reduces exactly the admin who physically
-- handed the cash in's held balance.
CREATE OR REPLACE FUNCTION trg_platform_ilan_settlement_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO platform_ilan_ledger_entries (platform_admin_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (NEW.platform_admin_id, NEW.settled_date, 'Cash handed in' || COALESCE(' — ' || NEW.note, ''), NEW.amount_pkr, 0, 'ilan_settlement', NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_platform_ilan_settlement_ledger ON platform_ilan_settlements;
CREATE TRIGGER trg_platform_ilan_settlement_ledger
  AFTER INSERT ON platform_ilan_settlements
  FOR EACH ROW EXECUTE FUNCTION trg_platform_ilan_settlement_ledger();

CREATE OR REPLACE FUNCTION public.record_ilan_cash_settlement(p_amount_pkr decimal, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_admin_id uuid;
BEGIN
  v_admin_id := current_platform_admin_id();
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'You do not have platform-admin access';
  END IF;
  INSERT INTO platform_ilan_settlements (platform_admin_id, amount_pkr, note, recorded_by)
  VALUES (v_admin_id, p_amount_pkr, NULLIF(trim(COALESCE(p_note, '')), ''), v_admin_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.my_ilan_cash_held()
RETURNS decimal
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(credit) - SUM(debit), 0)
    FROM platform_ilan_ledger_entries
   WHERE platform_admin_id = current_platform_admin_id();
$$;

-- ===================== Campaigns =====================

CREATE TABLE commercial_ilans (
  id uuid primary key default gen_random_uuid(),
  advertiser_portal_user_id uuid not null references portal_users(id),
  home_tenant_id uuid not null references tenants(id),
  vehicle_id uuid references vehicles(id),
  vehicle_route_id uuid references vehicle_routes(id),
  placement varchar not null check (placement in ('ticker', 'banner')),
  target_tenant_ids uuid[] not null,
  title_ur varchar not null,
  title_en varchar,
  body_ur text not null,
  body_en text,
  contact_mobile varchar,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rate_card_id uuid not null references ilan_rate_cards(id),
  price_pkr decimal not null check (price_pkr >= 0),
  status varchar not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected', 'cancelled')),
  is_paused boolean not null default false,
  rejection_reason text,
  reviewed_by uuid references platform_admins(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (array_length(target_tenant_ids, 1) > 0),
  check (ends_at > starts_at)
);

ALTER TABLE commercial_ilans ENABLE ROW LEVEL SECURITY;

CREATE POLICY commercial_ilans_advertiser_read ON commercial_ilans
  FOR SELECT TO authenticated
  USING (advertiser_portal_user_id = current_portal_user_id());

CREATE POLICY commercial_ilans_platform_read ON commercial_ilans
  FOR SELECT TO authenticated
  USING (is_platform_admin());

-- Public display -- only a currently-live, approved, unpaused campaign
-- targeted at the viewer's own tenant, same two-role split (logged-in
-- vs. anonymous public site) already proven on emergency_broadcasts.
CREATE POLICY commercial_ilans_display_authenticated ON commercial_ilans
  FOR SELECT TO authenticated
  USING (
    status = 'approved' AND is_paused = false
    AND starts_at <= now() AND ends_at > now()
    AND coalesce(my_tenant_id(), request_tenant_id()) = any(target_tenant_ids)
  );

CREATE POLICY commercial_ilans_display_public ON commercial_ilans
  FOR SELECT TO anon
  USING (
    status = 'approved' AND is_paused = false
    AND starts_at <= now() AND ends_at > now()
    AND request_tenant_id() = any(target_tenant_ids)
  );

-- Eligible ad-destination villages, for the composer's village picker.
-- Any authenticated portal_user/admin can see this (just id/name of
-- tenants that participate in the ilan network), unlike the fuller
-- tenants table which is otherwise locked to one's own tenant.
CREATE OR REPLACE FUNCTION public.ilan_target_tenants()
RETURNS TABLE (id uuid, name varchar, name_ur varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.name, t.name_ur FROM tenants t
   WHERE t.is_active = true AND t.commercial_ilans_enabled = true
   ORDER BY t.name;
$$;

CREATE OR REPLACE FUNCTION public.quote_commercial_ilan(
  p_placement varchar, p_target_tenant_ids uuid[], p_starts_at timestamptz, p_ends_at timestamptz
)
RETURNS decimal
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card ilan_rate_cards%rowtype;
  v_villages int;
  v_hours decimal;
  v_days decimal;
BEGIN
  SELECT * INTO v_card FROM ilan_rate_cards WHERE placement = p_placement AND is_active = true LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active rate card for %', p_placement;
  END IF;
  IF p_target_tenant_ids IS NULL OR array_length(p_target_tenant_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'Pick at least one village';
  END IF;
  IF p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'End time must be after start time';
  END IF;

  v_villages := array_length(p_target_tenant_ids, 1);
  v_hours := extract(epoch FROM (p_ends_at - p_starts_at)) / 3600.0;
  IF v_hours < v_card.min_hours THEN
    RAISE EXCEPTION 'Minimum run time is % hours', v_card.min_hours;
  END IF;
  v_days := v_hours / 24.0;
  IF v_days > v_card.max_days THEN
    RAISE EXCEPTION 'Maximum run time is % days', v_card.max_days;
  END IF;

  RETURN round(v_card.price_per_village_per_day_pkr * v_villages * v_days, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_commercial_ilan(
  p_vehicle_id uuid,
  p_placement varchar,
  p_target_tenant_ids uuid[],
  p_title_ur varchar,
  p_body_ur text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_vehicle_route_id uuid DEFAULT NULL,
  p_title_en varchar DEFAULT NULL,
  p_body_en text DEFAULT NULL,
  p_contact_mobile varchar DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_tenant_id uuid := my_tenant_id();
  v_card_id uuid;
  v_price decimal;
  v_id uuid;
  v_bad_target uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  IF NOT can_access_system('commercial_ilans') THEN
    RAISE EXCEPTION 'Your village is not on the commercial ilan network yet';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM vehicles v WHERE v.id = p_vehicle_id AND v.portal_user_id = v_portal_user_id AND v.is_active = true
  ) THEN
    RAISE EXCEPTION 'You can only advertise your own vehicle';
  END IF;
  IF p_vehicle_route_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vehicle_routes r WHERE r.id = p_vehicle_route_id AND r.vehicle_id = p_vehicle_id
  ) THEN
    RAISE EXCEPTION 'Route does not belong to this vehicle';
  END IF;
  IF coalesce(trim(p_title_ur), '') = '' OR coalesce(trim(p_body_ur), '') = '' THEN
    RAISE EXCEPTION 'An ilan needs an Urdu title and message';
  END IF;

  SELECT t.id INTO v_bad_target FROM unnest(p_target_tenant_ids) AS t(id)
   WHERE NOT EXISTS (SELECT 1 FROM tenants tt WHERE tt.id = t.id AND tt.is_active = true AND tt.commercial_ilans_enabled = true)
   LIMIT 1;
  IF v_bad_target IS NOT NULL THEN
    RAISE EXCEPTION 'One of the selected villages is not eligible for ilans';
  END IF;

  SELECT id INTO v_card_id FROM ilan_rate_cards WHERE placement = p_placement AND is_active = true LIMIT 1;
  IF v_card_id IS NULL THEN
    RAISE EXCEPTION 'No active rate card for %', p_placement;
  END IF;

  v_price := quote_commercial_ilan(p_placement, p_target_tenant_ids, p_starts_at, p_ends_at);

  INSERT INTO commercial_ilans (
    advertiser_portal_user_id, home_tenant_id, vehicle_id, vehicle_route_id, placement,
    target_tenant_ids, title_ur, title_en, body_ur, body_en, contact_mobile,
    starts_at, ends_at, rate_card_id, price_pkr
  ) VALUES (
    v_portal_user_id, v_tenant_id, p_vehicle_id, p_vehicle_route_id, p_placement,
    p_target_tenant_ids, trim(p_title_ur), nullif(trim(coalesce(p_title_en, '')), ''), trim(p_body_ur), nullif(trim(coalesce(p_body_en, '')), ''), p_contact_mobile,
    p_starts_at, p_ends_at, v_card_id, v_price
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_commercial_ilan(p_ilan_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE commercial_ilans SET status = 'cancelled'
   WHERE id = p_ilan_id AND advertiser_portal_user_id = current_portal_user_id() AND status = 'pending_approval';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot cancel this ilan';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_commercial_ilan(p_ilan_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE commercial_ilans SET is_paused = true
   WHERE id = p_ilan_id AND advertiser_portal_user_id = current_portal_user_id() AND status = 'approved' AND ends_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot pause this ilan';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_commercial_ilan(p_ilan_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE commercial_ilans SET is_paused = false
   WHERE id = p_ilan_id AND advertiser_portal_user_id = current_portal_user_id() AND status = 'approved' AND ends_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot resume this ilan';
  END IF;
END;
$$;

-- Approval and cash collection happen together: the platform admin who
-- reviews a request is, in practice, the same person who just took the
-- advertiser's cash in hand, so this one action both approves the
-- content and marks that admin as now holding that money (credit =
-- they now owe it to the platform until they settle it).
CREATE OR REPLACE FUNCTION public.platform_approve_ilan(p_ilan_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin_id uuid; v_price decimal;
BEGIN
  v_admin_id := current_platform_admin_id();
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'You do not have platform-admin access';
  END IF;

  UPDATE commercial_ilans SET status = 'approved', reviewed_by = v_admin_id, reviewed_at = now()
   WHERE id = p_ilan_id AND status = 'pending_approval'
  RETURNING price_pkr INTO v_price;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan is not pending approval';
  END IF;

  INSERT INTO platform_ilan_ledger_entries (platform_admin_id, particular, debit, credit, reference_type, reference_id)
  VALUES (v_admin_id, 'Cash collected for ilan ' || p_ilan_id, 0, v_price, 'commercial_ilan', p_ilan_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_reject_ilan(p_ilan_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'You do not have platform-admin access';
  END IF;
  UPDATE commercial_ilans SET status = 'rejected', rejection_reason = p_reason, reviewed_by = current_platform_admin_id(), reviewed_at = now()
   WHERE id = p_ilan_id AND status = 'pending_approval';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ilan is not pending approval';
  END IF;
END;
$$;
