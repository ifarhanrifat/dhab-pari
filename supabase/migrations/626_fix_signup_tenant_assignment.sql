-- Real bug, found 2026-10-07 while reviewing the new subdomain feature:
-- every path that creates a NEW portal_users or admin_users row through
-- the service-role client (bypasses RLS entirely) relies on the column's
-- own tenant_id DEFAULT (coalesce(my_tenant_id(), dhab-pari)) to assign a
-- tenant. A service-role connection has no auth.uid() at all, so
-- my_tenant_id() is always NULL there -- meaning every portal signup,
-- regardless of which village's subdomain it came from, was silently
-- landing in dhab-pari's tenant. match_donor_account_by_phone has the
-- same problem one level deeper: it's called from that same service-role
-- signup path to auto-link a new donor's phone number, so it was only
-- ever matching dhab-pari's own donor accounts for every signup.
--
-- Fixed at the app-code level (src/lib/portalSignup.ts and the two
-- /api/portal/signup routes now resolve and pass the real tenant
-- explicitly) and here: match_donor_account_by_phone gets an optional
-- p_tenant_id parameter, additive and backward compatible — its other
-- existing caller (the authenticated-context verify-donor-phone-match
-- flow from migration 357) keeps calling it with just p_phone and keeps
-- resolving via my_tenant_id() exactly as before.
create or replace function public.match_donor_account_by_phone(p_phone character varying, p_tenant_id uuid DEFAULT NULL::uuid)
 returns table(account_id uuid, donor_account_no character varying, name character varying, name_ur character varying, total_contributed numeric, already_claimed boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_core text := phone_core_digits(p_phone);
BEGIN
  IF v_core = '' OR length(v_core) < 7 THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.donor_account_no, a.name, a.name_ur,
    COALESCE((SELECT SUM(le.credit) - SUM(le.debit) FROM ledger_entries le WHERE le.account_id = a.id), 0)::numeric,
    EXISTS (SELECT 1 FROM portal_users pu WHERE pu.donor_account_id = a.id AND pu.auth_user_id IS NOT NULL)
  FROM accounts a
  WHERE a.system = 'donors_projects' AND a.type = 'donor'
    AND a.tenant_id = coalesce(p_tenant_id, my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND phone_core_digits(a.donor_key) = v_core
  ORDER BY (a.donor_account_no IS NOT NULL) DESC
  LIMIT 1;
END;
$function$;
