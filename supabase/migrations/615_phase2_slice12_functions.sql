-- Phase 2, slice 12 (functions): the final 4 functions touching only
-- account_headers/term_labels/ui_overrides -- the last slice of Phase 2.
-- Reproduced from the real, current body (pulled live via
-- pg_get_functiondef) with only the minimal tenant-scoping fix applied.
--
-- ensure_expense_account and ensure_project_account both looked up their
-- account_headers row by the bare business key (system, code) with no
-- tenant filter -- now a correctness bug, not just a leak, since
-- account_headers is keyed (tenant_id, system, code) as of slice 12's
-- schema migration: a bare `WHERE system = ... AND code = ...` throws
-- "more than one row returned by a subquery" the moment a second tenant
-- has its own header row for the same section. ensure_expense_account's
-- `accounts WHERE ... AND name = p_name` lookup had the same missing
-- filter, risking reuse of a different tenant's expense account that
-- happened to share the same name.
--
-- language_pack (the i18n term/UI-override pack, loaded on every page
-- including pre-login) had no tenant filter on either table at all --
-- fixed with the same public-browse coalesce(my_tenant_id(), <dhab-pari>)
-- pattern used throughout this phase.
--
-- next_account_code is left unchanged: it only ever receives a
-- p_header_id that its two callers now resolve correctly for their own
-- tenant, so it is transitively tenant-safe with no fix of its own.

create or replace function public.ensure_expense_account(p_name character varying)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_header_id uuid;
  v_code varchar;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE system = 'donors_projects' AND type = 'expense' AND name = p_name AND tenant_id = my_tenant_id();
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;

  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'expense' AND tenant_id = my_tenant_id();
  v_code := next_account_code(v_header_id);

  INSERT INTO accounts (code, name, type, system, opening_balance)
  VALUES (v_code, p_name, 'expense', 'donors_projects', 0)
  RETURNING id INTO v_account_id;

  RETURN v_account_id;
END;
$function$;

create or replace function public.ensure_project_account(p_project_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_title varchar;
  v_title_ur varchar;
  v_tenant_id uuid;
  v_header_id uuid;
BEGIN
  SELECT id INTO v_account_id FROM accounts WHERE project_id = p_project_id;
  IF v_account_id IS NOT NULL THEN RETURN v_account_id; END IF;
  SELECT title, title_ur, tenant_id INTO v_title, v_title_ur, v_tenant_id FROM projects WHERE id = p_project_id;
  SELECT id INTO v_header_id FROM account_headers WHERE system = 'donors_projects' AND code = 'project' AND tenant_id = v_tenant_id;
  INSERT INTO accounts (code, name, name_ur, type, system, project_id, opening_balance, tenant_id)
  VALUES (next_account_code(v_header_id), v_title, v_title_ur, 'project', 'donors_projects', p_project_id, 0, v_tenant_id)
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$function$;

create or replace function public.language_pack()
 returns TABLE(language text, terms jsonb, overrides jsonb)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT
    my_language(),
    (SELECT COALESCE(jsonb_object_agg(category || '.' || code,
              jsonb_build_object('en', label_en, 'ur', label_ur)), '{}'::jsonb)
       FROM term_labels WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)),
    (SELECT COALESCE(jsonb_object_agg(locale || '.' || key, value), '{}'::jsonb)
       FROM ui_overrides WHERE tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));
$function$;
