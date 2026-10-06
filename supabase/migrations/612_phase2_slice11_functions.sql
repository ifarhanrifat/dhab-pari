-- Phase 2, slice 11 (functions): every function touching only slice-11
-- tables (agriculture reference data + water-supply connection
-- templates), reproduced from the real, current body (pulled live via
-- pg_get_functiondef) with only the minimal tenant-scoping fix applied.
--
-- get_transactions_workspace_shell is the counterpart to slice 7's
-- get_transactions_workspace_documents -- the admin "new transaction"
-- workspace screen -- and had no tenant filter on almost every one of its
-- eight data sources (accounts, ledger_entries, consumers,
-- connection_templates, projects, approval_requests, inventory_items,
-- service_items). An admin on any tenant could see every other tenant's
-- chart of accounts, consumers, projects, pending approvals and
-- inventory when opening this screen.
--
-- broadcast_weather_alert had no tenant filter or parameter at all --
-- fixed with the same `p_tenant_id uuid DEFAULT NULL` pattern used for
-- compute_monthly_closing_core, since a weather event is specific to one
-- tenant's region/village. Its `ON CONFLICT (alert_date)` target is also
-- updated to match slice 11's re-keyed (tenant_id, alert_date)
-- constraint, which it would otherwise no longer match at all.
--
-- get_alert_expiry_hours's bare `WHERE alert_type = p_alert_type` lookup
-- is now a correctness bug, not just a leak, since alert_expiry_settings
-- is keyed (tenant_id, alert_type) as of this slice's schema migration --
-- fixed the same way, with callers that already know a specific tenant
-- (notify_ticker_new_chanda, broadcast_weather_alert) passing it
-- explicitly rather than relying on my_tenant_id().
--
-- trg_protect_inventory_item_delete / trg_protect_service_item_delete are
-- left unchanged -- each is keyed entirely by OLD.id, the exact row being
-- deleted, so transitively tenant-safe with no fix needed.

create or replace function public.get_alert_expiry_hours(p_alert_type character varying, p_tenant_id uuid DEFAULT NULL::uuid)
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE((SELECT default_hours FROM alert_expiry_settings WHERE alert_type = p_alert_type AND tenant_id = COALESCE(p_tenant_id, my_tenant_id())), 168);
$function$;

-- broadcast_weather_alert: a weather event is specific to one tenant's
-- region/village -- fixed with an explicit p_tenant_id parameter
-- (appended as trailing/optional so the call signature stays
-- compatible), threaded into every insert, and the ON CONFLICT target
-- updated to match this slice's re-keyed constraint.
create or replace function public.broadcast_weather_alert(p_body_en text, p_body_ur text, p_rain_chance integer, p_wind_kph integer, p_tenant_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_tenant_id uuid := COALESCE(p_tenant_id, my_tenant_id());
  v_id uuid; v_ticker uuid;
  v_expires_at timestamptz := now() + (get_alert_expiry_hours('weather_alert', v_tenant_id) || ' hours')::interval;
BEGIN
  INSERT INTO weather_alerts_log (alert_date, rain_chance, wind_kph, tenant_id) VALUES (current_date, p_rain_chance, p_wind_kph, v_tenant_id)
  ON CONFLICT (tenant_id, alert_date) DO NOTHING;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience, audience_countries, is_public, expires_at, tenant_id)
  VALUES ('weather', 'important', 'Weather Alert', 'موسم کی وارننگ', p_body_en, p_body_ur, 'everyone', '{}', true, v_expires_at, v_tenant_id)
  RETURNING id INTO v_id;

  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, is_appeal_mirror, tenant_id)
  VALUES (p_body_en, p_body_ur, true, -100, v_expires_at, true, v_tenant_id)
  RETURNING id INTO v_ticker;
  UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  SELECT id, 'weather_alert', 'Weather Alert', p_body_ur || chr(10) || p_body_en, '/weather', v_tenant_id
  FROM portal_users WHERE is_active = true AND notify_weather_alerts = true AND tenant_id = v_tenant_id;

  RETURN v_id;
END;
$function$;

-- get_transactions_workspace_shell: the admin "new transaction" workspace
-- screen -- had no tenant filter on almost every one of its data sources.
create or replace function public.get_transactions_workspace_shell(p_system character varying)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_default_template_id uuid;
BEGIN
  IF NOT can_access_system(p_system) THEN
    RAISE EXCEPTION 'Not authorized for this system';
  END IF;

  IF p_system = 'water_supply' THEN
    SELECT id INTO v_default_template_id FROM connection_templates WHERE system = 'water_supply' AND is_default = true AND tenant_id = my_tenant_id() LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    -- Spans both systems for roles allowed both (the account picker's original
    -- intent), but never leaks a book the caller has no access to — mirrors
    -- the accounts_read RLS policy this function bypasses.
    'accounts', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', a.id, 'name', a.name, 'name_ur', a.name_ur, 'type', a.type, 'code', a.code, 'system', a.system, 'opening_balance', a.opening_balance
      ) ORDER BY a.name), '[]'::jsonb) FROM accounts a WHERE a.is_active = true AND a.tenant_id = my_tenant_id() AND can_access_system(a.system)),
    'ledger_balances', (SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.debit, 'credit', l.credit)), '[]'::jsonb)
      FROM ledger_entries l WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.id = l.account_id AND a.tenant_id = my_tenant_id() AND can_access_system(a.system))),
    'consumers', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('consumer_id', c.consumer_id, 'name', c.name, 'monthly_rate', c.monthly_rate, 'connections', c.connections) ORDER BY c.name), '[]'::jsonb)
       FROM consumers c WHERE c.status = 'active' AND c.tenant_id = my_tenant_id())
      ELSE '[]'::jsonb END,
    'advance_balances', CASE WHEN p_system = 'water_supply' THEN get_consumer_advance_balances() ELSE '{}'::jsonb END,
    'projects', CASE WHEN p_system = 'donors_projects' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', pr.id, 'title', pr.title) ORDER BY pr.title), '[]'::jsonb) FROM projects pr WHERE pr.tenant_id = my_tenant_id())
      ELSE '[]'::jsonb END,
    'pending_approvals', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', ar.id, 'kind', ar.kind, 'particular', ar.particular, 'amount_pkr', ar.amount_pkr, 'created_at', ar.created_at
      ) ORDER BY ar.created_at DESC), '[]'::jsonb) FROM approval_requests ar WHERE ar.system = p_system AND ar.status = 'pending' AND ar.tenant_id = my_tenant_id()),
    'inventory_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', ii.id, 'name', ii.name, 'unit_price', ii.unit_price, 'unit_cost', ii.unit_cost, 'unit', ii.unit) ORDER BY ii.name), '[]'::jsonb)
       FROM inventory_items ii WHERE ii.is_active = true AND ii.tenant_id = my_tenant_id())
      ELSE '[]'::jsonb END,
    'service_items', CASE WHEN p_system = 'water_supply' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', si.id, 'name', si.name, 'charge_amount', si.charge_amount) ORDER BY si.name), '[]'::jsonb)
       FROM service_items si WHERE si.is_active = true AND si.tenant_id = my_tenant_id())
      ELSE '[]'::jsonb END,
    'default_template_items', CASE WHEN v_default_template_id IS NOT NULL THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'item_type', cti.item_type, 'inventory_item_id', cti.inventory_item_id, 'service_item_id', cti.service_item_id, 'quantity', cti.quantity
        )), '[]'::jsonb) FROM connection_template_items cti WHERE cti.template_id = v_default_template_id)
      ELSE '[]'::jsonb END
  );
END;
$function$;

-- notify_ticker_new_chanda: re-issued from slice 10 (migration 609) to
-- pass its known tenant explicitly to get_alert_expiry_hours's new
-- signature, rather than relying on my_tenant_id() inside a trigger.
create or replace function public.notify_ticker_new_chanda()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NEW.is_active THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at, tenant_id)
    VALUES (
      'New Chanda started: ' || NEW.title || ' — see dhabpari.com/chanda',
      'نیا چندہ شروع ہوا: ' || COALESCE(NEW.title_ur, NEW.title) || ' — دیکھیں dhabpari.com/chanda',
      true, -50, now() + (get_alert_expiry_hours('chanda_announcement', NEW.tenant_id) || ' hours')::interval, NEW.tenant_id
    );
  END IF;
  RETURN NEW;
END;
$function$;
