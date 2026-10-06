-- ensure_vehicle_account inserted into accounts without setting tenant_id
-- explicitly, relying on the column's DEFAULT coalesce(my_tenant_id(), ...)
-- -- the same no-auth-context bug class as the pg_cron jobs, just surfaced
-- here by any caller without a resolved auth.uid() (caught live while
-- isolation-testing slice 2: a superuser test insert on a *second* tenant's
-- vehicle created its auto-generated account under Dhab Pari's tenant
-- instead). Fixed by reading the vehicle's own tenant_id and setting it
-- explicitly, same pattern as the trigger-based ledger-posting fixes in
-- migration 569.
create or replace function public.ensure_vehicle_account(p_vehicle_id uuid)
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
  SELECT id INTO v_account_id FROM accounts WHERE vehicle_id = p_vehicle_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT owner_name, tenant_id INTO v_name, v_tenant_id FROM vehicles WHERE id = p_vehicle_id;
  INSERT INTO accounts (code, name, type, system, vehicle_id, opening_balance, tenant_id)
  VALUES ('VEH-' || substr(replace(p_vehicle_id::text, '-', ''), 1, 8), v_name, 'vehicle_owner', 'donors_projects', p_vehicle_id, 0, v_tenant_id)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$function$;
