-- Real, serious gap found 2026-10-08: visiting dhab-khushal.dhabpari.com
-- showed dhab-pari's own real numbers (PKR 325,558 available funds, 6
-- active projects, PKR 15,000 donations this month) on a brand new,
-- empty tenant's public homepage. Confirmed live two ways: (1) curl with
-- the x-tenant-id cookie correctly present and persisted across two
-- requests still rendered dhab-pari's content; (2) a direct PostgREST
-- call with the x-tenant-id HEADER set resolved news_posts correctly
-- (empty, as expected for a fresh tenant) — proving request_tenant_id()
-- and the table-level RLS policies from migration 624 work exactly as
-- designed. The bug is narrower and worse than a policy gap: it's in
-- SECURITY DEFINER *functions* the public site calls via .rpc(), which
-- each compute their own tenant id internally via
-- coalesce(my_tenant_id(), '<dhab-pari-uuid>') — never consulting
-- request_tenant_id() at all, because migration 624's sweep only ever
-- touched RLS policies, not function bodies. homepage_stats() is the
-- one that leaked the numbers above; the same exact pattern was found
-- in 67 other functions by searching every function in the public
-- schema for this literal fallback shape.
--
-- Fixed the same way migration 624 fixed the 62 RLS policies: insert
-- request_tenant_id() into the coalesce chain, between my_tenant_id()
-- and the hardcoded dhab-pari fallback, so an authenticated session
-- (my_tenant_id() non-null) is completely unaffected — this only
-- changes behavior for anonymous visitors, exactly the case that was
-- broken. Done as a mechanical string substitution over each function's
-- own freshly-pulled, live pg_get_functiondef() output and re-executed
-- — not retyped by hand — both because 68 functions is too many to
-- safely hand-copy without a transcription error, and because every
-- substitution is over the REAL current body, never reconstructed from
-- memory. None of these functions have their parameter list touched
-- (only internal body text), so this carries none of the CREATE OR
-- REPLACE overload risk documented elsewhere in this project's history.
do $outer$
declare
  r record;
  new_def text;
  n_fixed int := 0;
begin
  for r in
    select p.oid, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and pg_get_functiondef(p.oid) ilike '%bf9e4815-4104-472a-ab32-114171b7e34d%'
      and pg_get_functiondef(p.oid) ilike '%my_tenant_id()%'
      and pg_get_functiondef(p.oid) not ilike '%request_tenant_id()%'
  loop
    new_def := r.def;

    -- Shape 1: coalesce(my_tenant_id(), '<uuid>'::uuid) — the common case.
    new_def := replace(
      new_def,
      'coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)',
      'coalesce(my_tenant_id(), request_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)'
    );
    -- Same shape, uppercase COALESCE (pg_get_functiondef is inconsistent
    -- about preserving original casing across different-era migrations).
    new_def := replace(
      new_def,
      'COALESCE(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)',
      'COALESCE(my_tenant_id(), request_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)'
    );
    -- Shape 2: match_donor_account_by_phone's own p_tenant_id parameter
    -- leads the chain — insert request_tenant_id() as the fallback
    -- between the session and the hardcoded default, same as shape 1.
    new_def := replace(
      new_def,
      'coalesce(p_tenant_id, my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)',
      'coalesce(p_tenant_id, my_tenant_id(), request_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)'
    );

    if new_def <> r.def then
      execute new_def;
      n_fixed := n_fixed + 1;
    end if;
  end loop;

  raise notice 'Fixed % functions', n_fixed;
end
$outer$;
