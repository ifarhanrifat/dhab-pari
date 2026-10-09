-- Same bug as migration 637, found in a different object type: 20 VIEWS
-- (not functions) each compute their own tenant id internally via
-- coalesce(my_tenant_id(), '<dhab-pari-uuid>') and never consult
-- request_tenant_id() -- migration 624's sweep covered RLS *policies*,
-- migration 637 covered SECURITY DEFINER *functions*, but views were
-- never searched at all. All 20 were created in migration 620 ("CRITICAL
-- SECURITY FIX... 17 more views discovered") with this exact pattern
-- baked into each view's own WHERE clause, which is a materially
-- different code path from a table's RLS policy and wasn't caught by
-- either earlier sweep.
--
-- Confirmed live: the homepage's "Our Achievements" section
-- (achievements_public) and the welfare/Kafalat-Wazifa-Zakat cards
-- (reading through donors_public, project_*_public, volunteers_public,
-- talent_showcase_*_public, etc.) were showing dhab-pari's own real
-- content on dhab-khushal.dhabpari.com -- these are exactly the 20
-- views below.
--
-- Fixed identically to 637's own methodology: request_tenant_id()
-- inserted into each view's coalesce chain via a mechanical string
-- substitution over the live, freshly-pulled pg_get_viewdef() output,
-- re-executed as CREATE OR REPLACE VIEW (same column list/types
-- throughout, so this is always a safe no-structural-change replace).
-- Authenticated sessions are unaffected (my_tenant_id() already wins
-- there); this only changes anonymous public-site behavior.
do $outer$
declare
  r record;
  new_def text;
  n_fixed int := 0;
begin
  for r in
    select c.oid, c.relname, pg_get_viewdef(c.oid) as def
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and pg_get_viewdef(c.oid) ilike '%bf9e4815-4104-472a-ab32-114171b7e34d%'
      and pg_get_viewdef(c.oid) ilike '%my_tenant_id()%'
      and pg_get_viewdef(c.oid) not ilike '%request_tenant_id()%'
  loop
    new_def := replace(
      r.def,
      'COALESCE(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)',
      'COALESCE(my_tenant_id(), request_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)'
    );
    new_def := replace(
      new_def,
      'coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)',
      'coalesce(my_tenant_id(), request_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)'
    );

    if new_def <> r.def then
      execute format('create or replace view public.%I as %s', r.relname, new_def);
      n_fixed := n_fixed + 1;
    end if;
  end loop;

  raise notice 'Fixed % views', n_fixed;
end
$outer$;
