-- Phase 2, slice 6 (functions + views): every function touching only
-- slice-6 tables (projects/appeals/committee/needs-register/ratings/etc,
-- no other still-unscoped table), plus 4 public views that turned out to
-- be a more serious, already-live finding.
--
-- CRITICAL: donors_public, project_expenses_public, project_accounts_public,
-- project_comments_public are plain views owned by `postgres` with no
-- `security_invoker`, granted straight to anon/authenticated -- they run
-- with the OWNER's privileges and therefore bypass RLS on their
-- underlying tables entirely. Before this migration `projects` had no
-- tenant_id, so these views could not have been scoped; now that it does,
-- they're fixed with a `coalesce(my_tenant_id(), <dhab-pari>)` filter,
-- same as every other public-browse surface this phase. Without this fix,
-- the moment a second tenant exists, any anonymous visitor to either
-- tenant's site could read the OTHER tenant's donor names/amounts
-- (donors_public), expense ledger line items (project_expenses_public),
-- and project-to-account mappings (project_accounts_public) by simply
-- querying these views directly -- RLS on the base tables would never be
-- consulted. project_comments_public additionally feeds the live public
-- project detail page (src/app/(public)/projects/[id]/page.tsx) via a
-- bare `.select('*')`.
--
-- Cron jobs with real bugs:
--   run_meeting_due_reminder_sweep: read message_templates/site_settings/
--   notification_preferences as bare globals (now a correctness bug, not
--   just a leak -- all three are keyed (tenant_id, key)) and swept
--   committee_members with no tenant filter, writing reminder_queue rows
--   with no tenant_id (the same no-auth-context DEFAULT bug fixed
--   elsewhere this phase). Restructured to loop per active tenant.
--
-- Business-key / unscoped lookups: admin_list_complaints, admin_resolve_
-- complaint, appeals_history, confirm_donation, donation_thanks_text,
-- donors_public_totals, get_meetings_project_activity, homepage_stats,
-- my_appeals, needs_apply_verification, needs_register_summary,
-- post_agenda_comment_reply, public_appeals, public_private_projects_total,
-- reopen_appeal, set_project_comment_hidden, trg_donor_ledger,
-- wazifa_check_zakat_family, wazifa_confirm_zakat_match,
-- wazifa_family_check, zakat_freeze_round, zakat_round_report -- each
-- fixed with the minimal targeted filter (my_tenant_id() for
-- authenticated-only functions, coalesce(...) for public ones, or the
-- already-loaded row's own tenant_id).
--
-- transfer_project_funds was the most serious of these: an admin with
-- post_transactions on ANY tenant could move committee funds between two
-- arbitrary project ids with no check that either belonged to their own
-- tenant. Fixed by requiring both ends to resolve to the caller's own
-- tenant before touching any account.
--
-- file_complaint and flag_project_comment had the cross-tenant
-- secondary-row-lookup pattern found throughout slice 5 (vehicle/shop/
-- portal_user existence, and the parent comment lookup) -- fixed the
-- same way.
--
-- trg_donor_project_comment and trg_project_task_notify are triggers
-- inserting into project_comments/portal_notifications relying on the
-- no-auth-context DEFAULT -- fixed with the row's own tenant_id, same
-- pattern as every other trigger fixed this phase.

create or replace view donors_public as
select d.id,
       case
         when d.is_anonymous then 'Anonymous'
         when p.hide_donor_names then 'Confidential'
         else d.name
       end as name,
       case when d.is_anonymous or p.hide_donor_names then null else d.name_ur end as name_ur,
       d.amount_pkr, d.date, d.project_id, d.donor_type, d.is_verified, d.payment_status
from donors d
left join projects p on p.id = d.project_id
where d.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  and (d.project_id is null
       or (coalesce(p.is_private, false) = false and coalesce(p.hide_donations, false) = false));

create or replace view project_expenses_public as
select a.project_id, le.id, le.entry_date, le.particular, le.debit
from ledger_entries le
join accounts a on a.id = le.account_id
join projects p on p.id = a.project_id
where a.project_id is not null and le.debit > 0
  and p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  and p.is_private = false and p.hide_expenses = false;

create or replace view project_accounts_public as
select a.id, a.project_id from accounts a
join projects p on p.id = a.project_id
where a.project_id is not null
  and p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  and p.is_private = false;

drop view if exists project_comments_public;
create view project_comments_public as
select c.id,
    c.project_id,
    c.content,
    c.created_at,
    c.portal_user_id,
    c.admin_user_id,
    c.parent_comment_id,
    c.comment_type,
        case
            when c.comment_type::text = 'system'::text then c.system_label
            when c.comment_type::text = 'staff'::text then a.full_name
            else p.username
        end as username,
        case
            when c.comment_type::text = 'user'::text then p.avatar_url
            else null::text
        end as avatar_url,
        case
            when c.comment_type::text = 'user'::text then donor_badge_tier(p.id)
            else null::character varying
        end as badge_tier,
        case
            when c.comment_type::text = 'staff'::text then a.role
            else null::character varying
        end as staff_role,
    ( select count(*) as count
           from project_comment_likes l
          where l.comment_id = c.id) as like_count
   from project_comments c
     left join portal_users p on p.id = c.portal_user_id
     left join admin_users a on a.id = c.admin_user_id
     left join projects pr on pr.id = c.project_id
  where c.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    and c.is_hidden = false
    and (c.project_id is null or coalesce(pr.is_private, false) = false and (c.comment_type::text <> 'system'::text or coalesce(pr.hide_donations, false) = false and coalesce(pr.hide_donor_names, false) = false));

grant select on donors_public to anon, authenticated;
grant select on project_expenses_public to anon, authenticated;
grant select on project_accounts_public to anon, authenticated;
grant select on project_comments_public to anon, authenticated;

create or replace function public.admin_list_complaints(p_status character varying DEFAULT NULL::character varying)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'kind', c.kind, 'note', c.note, 'is_urgent', c.is_urgent, 'status', c.status,
    'against_party_type', c.against_party_type, 'against_party_id', c.against_party_id,
    'against_name', CASE c.against_party_type
      WHEN 'vehicle' THEN (SELECT owner_name FROM vehicles WHERE id = c.against_party_id)
      WHEN 'shop' THEN (SELECT name FROM shops WHERE id = c.against_party_id)
      WHEN 'portal_user' THEN (SELECT full_name FROM portal_users WHERE id = c.against_party_id)
    END,
    'filed_by_name', COALESCE(
      (SELECT full_name FROM portal_users WHERE id = c.filed_by_portal_user_id),
      (SELECT full_name FROM admin_users WHERE id = c.filed_by_admin_id)
    ),
    'ref_type', c.ref_type, 'ref_id', c.ref_id, 'resolution_note', c.resolution_note, 'resolved_at', c.resolved_at,
    'created_at', c.created_at
  ) ORDER BY c.is_urgent DESC, c.created_at DESC), '[]'::jsonb)
  FROM party_complaints c
  WHERE c.tenant_id = my_tenant_id() AND current_admin_permission('manage_parties') AND (p_status IS NULL OR c.status = p_status);
$function$;

create or replace function public.admin_resolve_complaint(p_complaint_id uuid, p_status character varying, p_resolution_note text DEFAULT NULL::text, p_block boolean DEFAULT false)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE c party_complaints%ROWTYPE;
BEGIN
  IF NOT current_admin_permission('manage_parties') THEN RAISE EXCEPTION 'You do not have permission to do this.' USING ERRCODE = 'P0001'; END IF;
  IF p_status NOT IN ('upheld', 'dismissed') THEN RAISE EXCEPTION 'Invalid status.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO c FROM party_complaints WHERE id = p_complaint_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found.' USING ERRCODE = 'P0001'; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'This complaint was already resolved.' USING ERRCODE = 'P0001'; END IF;

  UPDATE party_complaints SET status = p_status, resolution_note = NULLIF(p_resolution_note, ''), resolved_by = current_admin_user_id(), resolved_at = now()
  WHERE id = p_complaint_id;

  -- The one place a complaint can immediately act on the system, not
  -- just score it: an upheld wrong-vehicle/wrong-driver report,
  -- explicitly confirmed by an admin, blocks the vehicle the same way
  -- the admin panel's own block button does.
  IF p_status = 'upheld' AND p_block AND c.against_party_type = 'vehicle' THEN
    UPDATE vehicles SET is_active = false WHERE id = c.against_party_id;
  END IF;
END;
$function$;

create or replace function public.appeals_history(p_limit integer DEFAULT 50)
 returns TABLE(id uuid, kind text, severity text, title_en text, body_ur text, body_en text, audience text, is_public boolean, status text, starts_at timestamp with time zone, expires_at timestamp with time zone, created_at timestamp with time zone, closed_at timestamp with time zone, close_reason text, created_by text, closed_by text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.body_ur, a.body_en,
         a.audience::text, a.is_public, a.status::text,
         a.starts_at, a.expires_at, a.created_at, a.closed_at, a.close_reason,
         cb.full_name::text, xb.full_name::text
    FROM appeals a
    LEFT JOIN admin_users cb ON cb.id = a.created_by_admin_user_id
    LEFT JOIN admin_users xb ON xb.id = a.closed_by_admin_user_id
   WHERE a.tenant_id = my_tenant_id()
     AND EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true)
   ORDER BY a.created_at DESC
   LIMIT greatest(1, least(coalesce(p_limit, 50), 500));
$function$;

create or replace function public.confirm_donation(p_donor_id uuid, p_edits jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_donor donors%ROWTYPE;
  v_account_id uuid;
  v_account_no varchar;
  v_voucher_no varchar;
  v_admin_id uuid := current_admin_user_id();
  v_project_budget decimal;
  v_project_verified_total decimal;
  v_skip_voting boolean;
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to confirm donations';
  END IF;

  UPDATE donors SET
    name = COALESCE(p_edits->>'name', name),
    name_ur = COALESCE(p_edits->>'name_ur', name_ur),
    phone = COALESCE(p_edits->>'phone', phone),
    father_husband_name = COALESCE(p_edits->>'father_husband_name', father_husband_name),
    whatsapp_number = COALESCE(p_edits->>'whatsapp_number', whatsapp_number),
    donor_type = COALESCE(p_edits->>'donor_type', donor_type),
    amount_pkr = COALESCE((p_edits->>'amount_pkr')::decimal, amount_pkr),
    date = COALESCE((p_edits->>'date')::date, date),
    payment_method = COALESCE(p_edits->>'payment_method', payment_method),
    project_id = CASE WHEN p_edits ? 'project_id' THEN NULLIF(p_edits->>'project_id', '')::uuid ELSE project_id END,
    is_anonymous = COALESCE((p_edits->>'is_anonymous')::boolean, is_anonymous),
    notes = COALESCE(p_edits->>'notes', notes),
    is_verified = true, confirmed_at = now(), confirmed_by = v_admin_id
  WHERE id = p_donor_id AND tenant_id = my_tenant_id()
  RETURNING * INTO v_donor;

  IF NOT FOUND THEN RAISE EXCEPTION 'Donor not found'; END IF;

  v_account_id := ensure_donor_account(v_donor.name, v_donor.phone);
  SELECT donor_account_no INTO v_account_no FROM accounts WHERE id = v_account_id;
  IF v_account_no IS NULL THEN
    v_account_no := next_donor_account_no();
    UPDATE accounts SET donor_account_no = v_account_no WHERE id = v_account_id;
  END IF;

  v_voucher_no := v_donor.voucher_no;
  IF v_voucher_no IS NULL THEN
    v_voucher_no := next_voucher_no('donors_projects', 'income');
    UPDATE donors SET voucher_no = v_voucher_no WHERE id = p_donor_id;
  END IF;

  UPDATE portal_users SET donor_account_id = v_account_id
  WHERE donor_account_id IS NULL
    AND (lower(mobile) = lower(COALESCE(v_donor.phone, '')) OR lower(COALESCE(whatsapp_number, '')) = lower(COALESCE(v_donor.phone, '')));

  -- System comment + lifecycle checks.
  IF v_donor.project_id IS NOT NULL THEN
    INSERT INTO project_comments (project_id, comment_type, system_label, content)
    VALUES (v_donor.project_id, 'system', 'Donation System',
      (CASE WHEN v_donor.is_anonymous THEN 'An anonymous donor''s' ELSE v_donor.name || '''s' END) ||
      ' donation of Rs. ' || to_char(v_donor.amount_pkr, 'FM999999999') || ' has been confirmed!');

    -- Confirming the proposer's own self-commitment is what unlocks voting
    -- (or, for a badge-tier fast-track proposal, sends it straight to
    -- committee review instead).
    IF v_donor.is_proposal_commitment THEN
      SELECT skip_voting INTO v_skip_voting FROM projects WHERE id = v_donor.project_id;
      IF v_skip_voting THEN
        UPDATE projects SET status = 'reviewing' WHERE id = v_donor.project_id AND status = 'announced';
        INSERT INTO project_comments (project_id, comment_type, system_label, content)
        VALUES (v_donor.project_id, 'system', 'Proposal System',
          'The proposer''s self-commitment has been confirmed — as a badge-tier fast-track proposal, this now goes straight to the committee for review.');
      ELSE
        UPDATE projects SET status = 'upcoming' WHERE id = v_donor.project_id AND status = 'announced';
        INSERT INTO project_comments (project_id, comment_type, system_label, content)
        VALUES (v_donor.project_id, 'system', 'Proposal System',
          'The proposer''s self-commitment has been confirmed — this project is now open for voting!');
      END IF;
    END IF;

    SELECT budget_pkr INTO v_project_budget FROM projects WHERE id = v_donor.project_id;
    SELECT COALESCE(SUM(amount_pkr), 0) INTO v_project_verified_total FROM donors WHERE project_id = v_donor.project_id AND is_verified = true;
    IF v_project_budget IS NOT NULL AND v_project_verified_total >= v_project_budget THEN
      UPDATE projects SET status = 'reviewing' WHERE id = v_donor.project_id AND status = 'ongoing';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'donor_id', v_donor.id, 'name', v_donor.name, 'amount_pkr', v_donor.amount_pkr,
    'account_no', v_account_no, 'voucher_no', v_voucher_no
  );
END;
$function$;

create or replace function public.donation_thanks_text(p_donor_id uuid, p_lang text)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  d donors%ROWTYPE; v_project text; v_tpl text;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id AND tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
  IF d.id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(nullif(trim(display_name), ''),
           CASE WHEN p_lang = 'ur' THEN COALESCE(nullif(trim(title_ur), ''), title) ELSE title END)
    INTO v_project FROM projects WHERE id = d.project_id;
  v_project := COALESCE(v_project,
    CASE WHEN p_lang = 'ur' THEN 'جنرل فنڈ' ELSE 'the General Fund' END);

  v_tpl := CASE WHEN p_lang = 'ur'
    THEN setting_text('donation_thanks_ur', '%%who%% نے %%project%% کے لیے %%amount%% روپے کا عطیہ دیا ہے۔ جزاک اللہ خیر')
    ELSE setting_text('donation_thanks_en', '%%who%% has donated Rs. %%amount%% for %%project%%. Jazak Allah Khair') END;

  v_tpl := replace(v_tpl, '%%who%%', COALESCE(donation_thanks_who(p_donor_id, p_lang), ''));
  v_tpl := replace(v_tpl, '%%project%%', v_project);
  v_tpl := replace(v_tpl, '%%amount%%', trim(to_char(d.amount_pkr, 'FM999,999,999,990')));
  RETURN v_tpl;
END;
$function$;

create or replace function public.donors_public_totals()
 returns TABLE(name character varying, name_ur character varying, total_pkr numeric, donation_count integer, last_date date, project_id uuid)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  RETURN QUERY
  SELECT g.name, g.name_ur, g.total_pkr, g.donation_count, g.last_date, NULL::uuid AS project_id
  FROM (
    SELECT
      (array_agg(d.name ORDER BY d.date DESC))[1]::varchar AS name,
      (array_agg(d.name_ur ORDER BY d.date DESC))[1]::varchar AS name_ur,
      SUM(d.amount_pkr) AS total_pkr,
      COUNT(*)::int AS donation_count,
      MAX(d.date) AS last_date
    FROM donors d
    LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.tenant_id = v_tenant AND d.is_verified = true AND d.is_anonymous = false
      AND (d.project_id IS NULL OR (
        COALESCE(p.is_private, false) = false
        AND COALESCE(p.hide_donations, false) = false
        AND COALESCE(p.hide_donor_names, false) = false
      ))
    GROUP BY COALESCE(
      (SELECT a.donor_key FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.reference_type = 'donation' AND le.reference_id = d.id AND a.type = 'donor' LIMIT 1),
      donor_key_for(d.name, d.phone)
    )
  ) g

  UNION ALL

  SELECT
    (CASE WHEN d.is_anonymous THEN 'Anonymous' ELSE 'Confidential' END)::varchar AS name,
    NULL::varchar AS name_ur,
    d.amount_pkr AS total_pkr,
    1 AS donation_count,
    d.date AS last_date,
    d.project_id
  FROM donors d
  LEFT JOIN projects p ON p.id = d.project_id
  WHERE d.tenant_id = v_tenant AND d.is_verified = true
    AND (d.project_id IS NULL OR (COALESCE(p.is_private, false) = false AND COALESCE(p.hide_donations, false) = false))
    AND (d.is_anonymous OR COALESCE(p.hide_donor_names, false));
END;
$function$;

create or replace function public.file_complaint(p_against_party_type character varying, p_against_party_id uuid, p_kind character varying, p_note text, p_ref_type character varying DEFAULT NULL::character varying, p_ref_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_against_party_type NOT IN ('vehicle', 'shop', 'portal_user') THEN RAISE EXCEPTION 'Invalid target.' USING ERRCODE = 'P0001'; END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN RAISE EXCEPTION 'Describe what happened first.' USING ERRCODE = 'P0001'; END IF;
  IF p_against_party_type = 'vehicle' AND NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_against_party_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'That vehicle is not available.' USING ERRCODE = 'P0001';
  END IF;
  IF p_against_party_type = 'shop' AND NOT EXISTS (SELECT 1 FROM shops WHERE id = p_against_party_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'That shop is not available.' USING ERRCODE = 'P0001';
  END IF;
  IF p_against_party_type = 'portal_user' AND NOT EXISTS (SELECT 1 FROM portal_users WHERE id = p_against_party_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'That person is not available.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO party_complaints (filed_by_portal_user_id, against_party_type, against_party_id, kind, note, ref_type, ref_id, is_urgent)
  VALUES (v_portal_user_id, p_against_party_type, p_against_party_id, p_kind, trim(p_note), p_ref_type, p_ref_id, p_kind IN ('wrong_vehicle', 'wrong_driver'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

create or replace function public.flag_project_comment(p_comment_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_comment project_comments%ROWTYPE;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not logged in'; END IF;
  SELECT * INTO v_comment FROM project_comments WHERE id = p_comment_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Comment not found'; END IF;

  INSERT INTO complaints (system, portal_user_id, complainant_name, complaint_text, source, status)
  SELECT 'donors_projects', v_portal_user_id, full_name,
         'Flagged comment on project ' || v_comment.project_id || ': "' || v_comment.content || '"' ||
           CASE WHEN p_reason IS NOT NULL AND trim(p_reason) != '' THEN ' — Reason: ' || p_reason ELSE '' END,
         'website', 'open'
  FROM portal_users WHERE id = v_portal_user_id;
END;
$function$;

create or replace function public.get_meetings_project_activity(p_since timestamp with time zone)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN jsonb_build_object(
    'project_comments', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'projectId', pc.project_id, 'projectTitle', COALESCE(p.title, 'Untitled Project'), 'comments', pc.comments
        )), '[]'::jsonb)
      FROM (
        SELECT project_id, jsonb_agg(jsonb_build_object(
            'id', id, 'username', username, 'content', content, 'comment_type', comment_type, 'created_at', created_at
          ) ORDER BY created_at ASC) AS comments
        FROM project_comments_public
        WHERE created_at >= p_since
        GROUP BY project_id
      ) pc
      LEFT JOIN projects p ON p.id = pc.project_id
    ),
    'project_discussions', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'id', p.id, 'title', p.title, 'status', p.status, 'vote_target', p.vote_target,
          'vote_count', COALESCE(vc.cnt, 0), 'comments', COALESCE(cc.comments, '[]'::jsonb)
        ) ORDER BY p.created_at DESC), '[]'::jsonb)
      FROM projects p
      LEFT JOIN (SELECT project_id, count(*) AS cnt FROM project_votes WHERE tenant_id = my_tenant_id() GROUP BY project_id) vc ON vc.project_id = p.id
      LEFT JOIN (
        SELECT project_id, jsonb_agg(jsonb_build_object(
            'username', username, 'content', content, 'comment_type', comment_type, 'created_at', created_at
          ) ORDER BY created_at ASC) AS comments
        FROM project_comments_public GROUP BY project_id
      ) cc ON cc.project_id = p.id
      WHERE p.tenant_id = my_tenant_id() AND p.status IN ('upcoming', 'reviewing')
    )
  );
END;
$function$;

create or replace function public.homepage_stats()
 returns TABLE(available_funds numeric, active_projects bigint, donations_this_month numeric, registered_households bigint, revenue_this_month numeric, expenses_this_month numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  WITH v AS (SELECT coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AS tid)
  SELECT
    (SELECT COALESCE(SUM(a.opening_balance + COALESCE(le.net, 0)), 0) FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(debit) - SUM(credit) AS net FROM ledger_entries GROUP BY account_id) le ON le.account_id = a.id
       WHERE a.type IN ('cash', 'bank') AND a.tenant_id = v.tid),
    (SELECT COUNT(*) FROM projects WHERE status = 'ongoing' AND tenant_id = v.tid),
    (SELECT COALESCE(SUM(amount_pkr), 0) FROM donors WHERE is_verified = true AND date >= date_trunc('month', current_date) AND tenant_id = v.tid),
    (SELECT COUNT(*) FROM consumers WHERE tenant_id = v.tid),
    (SELECT COALESCE(SUM(le2.credit), 0) FROM ledger_entries le2 JOIN accounts a2 ON a2.id = le2.account_id
       WHERE a2.type = 'income' AND le2.entry_date >= date_trunc('month', current_date) AND a2.tenant_id = v.tid),
    (SELECT COALESCE(SUM(le3.debit), 0) FROM ledger_entries le3 JOIN accounts a3 ON a3.id = le3.account_id
       WHERE a3.type = 'expense' AND le3.entry_date >= date_trunc('month', current_date) AND a3.tenant_id = v.tid)
  FROM v;
$function$;

create or replace function public.my_appeals()
 returns TABLE(id uuid, kind text, severity text, title_en text, title_ur text, body_en text, body_ur text, contact_number text, created_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE u portal_users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF u.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.tenant_id = u.tenant_id
     AND a.status = 'active'
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
     AND CASE a.audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(a.audience_countries) = 0
                                  OR u.country = ANY (a.audience_countries))
       ELSE false
     END
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
END;
$function$;

create or replace function public.needs_apply_verification(p_register_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_min int;
  v_months int;
  v_verify int;
  v_reject int;
  v_status varchar;
BEGIN
  SELECT COALESCE(nullif(value, '')::int, 2) INTO v_min
    FROM site_settings WHERE key = 'needs_min_verifiers' AND tenant_id = my_tenant_id();
  v_min := COALESCE(v_min, 2);
  SELECT COALESCE(nullif(value, '')::int, 12) INTO v_months
    FROM site_settings WHERE key = 'needs_verification_months' AND tenant_id = my_tenant_id();
  v_months := COALESCE(v_months, 12);

  SELECT count(*) FILTER (WHERE decision = 'verify'),
         count(*) FILTER (WHERE decision = 'reject')
    INTO v_verify, v_reject
    FROM needs_verifications WHERE register_id = p_register_id;

  -- A rejection by anyone stops it: if one verifier who stood in the
  -- courtyard says no, that is a finding, not a vote to be outnumbered.
  IF v_reject > 0 THEN
    v_status := 'rejected';
    UPDATE needs_register SET status = 'rejected', updated_at = now()
     WHERE id = p_register_id AND tenant_id = my_tenant_id();
  ELSIF v_verify >= v_min THEN
    v_status := 'verified';
    UPDATE needs_register
       SET status = 'verified', verified_at = now(),
           verified_until = ((now() AT TIME ZONE 'Asia/Karachi')::date + make_interval(months => v_months))::date,
           updated_at = now()
     WHERE id = p_register_id AND tenant_id = my_tenant_id();
  ELSE
    v_status := 'surveying';
    UPDATE needs_register SET status = 'surveying', updated_at = now()
     WHERE id = p_register_id AND status = 'pending' AND tenant_id = my_tenant_id();
  END IF;

  RETURN jsonb_build_object('status', v_status, 'verifications', v_verify, 'required', v_min);
END;
$function$;

create or replace function public.needs_register_summary()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'verified_households', count(*) FILTER (WHERE status = 'verified'),
    'pending', count(*) FILTER (WHERE status IN ('pending', 'surveying')),
    'widow_headed', count(*) FILTER (WHERE status = 'verified' AND is_widow_headed),
    'with_orphans', count(*) FILTER (WHERE status = 'verified' AND has_orphans),
    'with_disabled', count(*) FILTER (WHERE status = 'verified' AND has_disabled_member),
    'school_age_children', COALESCE(sum(school_age_children) FILTER (WHERE status = 'verified'), 0),
    'total_dependants', COALESCE(sum(dependants) FILTER (WHERE status = 'verified'), 0)
  ) FROM needs_register WHERE tenant_id = my_tenant_id();
$function$;

create or replace function public.post_agenda_comment_reply(p_parent_comment_id uuid, p_content text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_project_id uuid;
  v_new_id uuid;
BEGIN
  IF NOT can_access_system('donors_projects') THEN
    RAISE EXCEPTION 'Not authorized to reply as the committee';
  END IF;
  IF p_content IS NULL OR trim(p_content) = '' THEN
    RAISE EXCEPTION 'Reply cannot be empty';
  END IF;

  SELECT project_id INTO v_project_id FROM project_comments WHERE id = p_parent_comment_id AND tenant_id = my_tenant_id();
  IF v_project_id IS NULL THEN RAISE EXCEPTION 'Comment not found'; END IF;

  INSERT INTO project_comments (project_id, comment_type, system_label, content, parent_comment_id)
  VALUES (v_project_id, 'system', 'Committee Reply', p_content, p_parent_comment_id)
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$;

create or replace function public.public_appeals()
 returns TABLE(id uuid, kind text, severity text, title_en text, title_ur text, body_en text, body_ur text, contact_number text, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
     AND a.status = 'active'
     AND a.is_public
     AND a.starts_at <= now()
     AND (a.expires_at IS NULL OR a.expires_at > now())
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
$function$;

create or replace function public.public_private_projects_total()
 returns numeric
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(SUM(b.total_debit), 0)
  FROM projects p
  JOIN accounts a ON a.project_id = p.id
  JOIN ledger_account_balances b ON b.account_id = a.id
  WHERE p.is_private = true AND p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
$function$;

create or replace function public.reopen_appeal(p_appeal_id uuid, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE a appeals%ROWTYPE; v_title_ur varchar;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to reopen an appeal';
  END IF;

  SELECT * INTO a FROM appeals WHERE id = p_appeal_id AND tenant_id = my_tenant_id() FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Appeal not found'; END IF;
  IF a.status = 'active' THEN RAISE EXCEPTION 'That appeal is already showing'; END IF;

  UPDATE appeals
     SET status = 'active', closed_at = NULL, closed_by_admin_user_id = NULL,
         close_reason = NULL, starts_at = now(),
         expires_at = COALESCE(p_expires_at, expires_at)
   WHERE id = p_appeal_id;

  PERFORM sync_appeal_tickers();

  v_title_ur := COALESCE(nullif(trim(coalesce(a.title_ur, '')), ''), 'ایک اپیل');

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  SELECT u.portal_user_id, 'appeal', v_title_ur, trim(a.body_ur), '/portal'
    FROM appeal_audience_users(a.audience, a.audience_countries) u;

  PERFORM notify_admins_pending_item('appeal', v_title_ur, trim(a.body_ur), '/admin/notifications');
END;
$function$;

-- run_meeting_due_reminder_sweep: restructured to loop over every active
-- tenant -- message_templates/site_settings/notification_preferences were
-- bare singleton reads (now a correctness bug, not just a leak, since all
-- three are keyed (tenant_id, key)), and committee_members/reminder_queue/
-- notifications had no tenant filter/tenant_id at all.
create or replace function public.run_meeting_due_reminder_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_tenant record;
  v_body text;
  v_site_url text;
  v_popup_enabled boolean;
  r record;
BEGIN
  -- Scoped delete — must never touch the other three tiers' pending rows,
  -- which run on a different (weekly) schedule.
  DELETE FROM reminder_queue WHERE status = 'pending' AND reminder_type = 'meeting_due';

  FOR v_tenant IN SELECT id FROM tenants WHERE is_active LOOP
    SELECT body INTO v_body FROM message_templates WHERE key = 'meeting_due_reminder' AND tenant_id = v_tenant.id;
    v_body := COALESCE(v_body, 'میٹنگ کی تاریخ قریب ہے، شرکت لازمی ہے۔ ایجنڈا پڑھیں اور کم از کم 2 تجاویز کے ساتھ آئیں۔ ایجنڈا یہاں دیکھیں: %%link%%');
    SELECT value INTO v_site_url FROM site_settings WHERE key = 'site_url' AND tenant_id = v_tenant.id;
    v_site_url := COALESCE(v_site_url, 'https://dhabpari.com');
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'meeting_due_reminder' AND tenant_id = v_tenant.id;

    FOR r IN
      SELECT cm.id AS committee_member_id, cm.name,
        CASE WHEN cm.uses_smartphone AND cm.admin_user_id IS NOT NULL THEN cm.phone ELSE proxy.mobile END AS phone,
        COALESCE(cm.admin_user_id, cm.proxy_admin_user_id) AS recipient_admin_user_id
      FROM committee_members cm
      LEFT JOIN admin_users proxy ON proxy.id = cm.proxy_admin_user_id
      WHERE cm.is_active = true AND cm.tenant_id = v_tenant.id
    LOOP
      INSERT INTO reminder_queue (reminder_type, target_name, target_phone, message, tenant_id)
      VALUES ('meeting_due', r.name, r.phone, replace(v_body, '%%link%%', v_site_url || '/admin/tasks/meetings'), v_tenant.id);

      IF r.recipient_admin_user_id IS NOT NULL AND v_popup_enabled IS DISTINCT FROM false THEN
        INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
        VALUES (r.recipient_admin_user_id, 'meeting_due_reminder', 'Meeting reminder',
          replace(v_body, '%%link%%', '/admin/tasks/meetings'), '/admin/tasks/meetings', v_tenant.id);
      END IF;
    END LOOP;
  END LOOP;
END;
$function$;

create or replace function public.set_project_comment_hidden(p_comment_id uuid, p_hidden boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE project_comments SET is_hidden = p_hidden, hidden_by = CASE WHEN p_hidden THEN current_admin_user_id() ELSE NULL END
  WHERE id = p_comment_id AND tenant_id = my_tenant_id();
END;
$function$;

create or replace function public.submit_rating(p_ref_type character varying, p_ref_id uuid, p_stars integer, p_comment text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_customer_portal_user_id uuid; v_provider_type varchar; v_provider_id uuid; v_terminal boolean := false;
  v_rater_type varchar; v_rater_id uuid; v_target_type varchar; v_target_id uuid; v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF p_stars IS NULL OR p_stars < 1 OR p_stars > 5 THEN RAISE EXCEPTION 'Pick 1 to 5 stars.' USING ERRCODE = 'P0001'; END IF;

  IF p_ref_type = 'dispatch_call' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM dispatch_calls WHERE id = p_ref_id AND tenant_id = my_tenant_id();
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'city_purchase_request' THEN
    SELECT initiator_portal_user_id, accepted_vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM city_purchase_requests WHERE id = p_ref_id AND tenant_id = my_tenant_id();
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'shop_order' THEN
    SELECT portal_user_id, shop_id, (fulfillment_status = 'delivered') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM shop_orders WHERE id = p_ref_id AND tenant_id = my_tenant_id();
    v_provider_type := 'shop';
  ELSIF p_ref_type = 'ride_booking' THEN
    SELECT rb.portal_user_id, vr.vehicle_id, (rb.status = 'confirmed')
      INTO v_customer_portal_user_id, v_provider_id, v_terminal
      FROM ride_bookings rb JOIN vehicle_routes vr ON vr.id = rb.route_id WHERE rb.id = p_ref_id AND rb.tenant_id = my_tenant_id();
    v_provider_type := 'vehicle';
  ELSIF p_ref_type = 'trip_booking' THEN
    SELECT portal_user_id, vehicle_id, (status = 'completed') INTO v_customer_portal_user_id, v_provider_id, v_terminal FROM vehicle_trip_bookings WHERE id = p_ref_id AND tenant_id = my_tenant_id();
    v_provider_type := 'vehicle';
  ELSE
    RAISE EXCEPTION 'This can''t be rated.' USING ERRCODE = 'P0001';
  END IF;

  IF v_customer_portal_user_id IS NULL THEN RAISE EXCEPTION 'Not found.' USING ERRCODE = 'P0001'; END IF;
  IF NOT v_terminal THEN RAISE EXCEPTION 'This can only be rated once it''s finished.' USING ERRCODE = 'P0001'; END IF;

  IF v_portal_user_id = v_customer_portal_user_id THEN
    v_rater_type := 'portal_user'; v_rater_id := v_portal_user_id;
    v_target_type := v_provider_type; v_target_id := v_provider_id;
  ELSIF v_provider_type = 'vehicle' AND EXISTS (SELECT 1 FROM vehicles WHERE id = v_provider_id AND portal_user_id = v_portal_user_id) THEN
    v_rater_type := 'vehicle'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSIF v_provider_type = 'shop' AND user_manages_shop(v_provider_id) THEN
    v_rater_type := 'shop'; v_rater_id := v_provider_id;
    v_target_type := 'portal_user'; v_target_id := v_customer_portal_user_id;
  ELSE
    RAISE EXCEPTION 'You are not part of this.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO ratings (ref_type, ref_id, rater_party_type, rater_party_id, target_party_type, target_party_id, stars, comment)
  VALUES (p_ref_type, p_ref_id, v_rater_type, v_rater_id, v_target_type, v_target_id, p_stars, NULLIF(p_comment, ''))
  ON CONFLICT (ref_type, ref_id, rater_party_type, rater_party_id) DO UPDATE SET stars = excluded.stars, comment = excluded.comment
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

-- transfer_project_funds: the real cross-tenant fund-movement bug found
-- this slice -- neither project id was ever checked against the admin's
-- own tenant before posting ledger entries between their accounts.
create or replace function public.transfer_project_funds(p_from_project_id uuid, p_to_project_id uuid, p_amount numeric, p_agenda_reference text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_from_account_id uuid;
  v_to_account_id uuid;
  v_particular text;
  v_reference_id uuid := gen_random_uuid();
BEGIN
  IF NOT can_access_system('donors_projects') OR NOT current_admin_permission('post_transactions') THEN
    RAISE EXCEPTION 'Not authorized to transfer project funds';
  END IF;
  IF p_agenda_reference IS NULL OR trim(p_agenda_reference) = '' THEN
    RAISE EXCEPTION 'An agenda/committee approval reference is required for a fund transfer';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Enter a valid amount'; END IF;
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = p_from_project_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'Source project not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = p_to_project_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'Destination project not found';
  END IF;

  v_from_account_id := ensure_project_account(p_from_project_id);
  v_to_account_id := ensure_project_account(p_to_project_id);
  v_particular := 'Fund transfer between projects — committee approval: ' || p_agenda_reference;

  -- Same reference_id on both legs — the established pairing convention
  -- (matches trg_donor_ledger()'s use of NEW.id for both its legs).
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_from_account_id, current_date, v_particular, p_amount, 0, 'project_transfer', v_reference_id);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_to_account_id, current_date, v_particular, 0, p_amount, 'project_transfer', v_reference_id);
END;
$function$;

create or replace function public.trg_donor_ledger()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_account_id uuid;
  v_cash_account_id uuid;
  v_project_account_id uuid;
  v_fund_account_id uuid;
  v_project_title text;
  v_particular text;
BEGIN
  v_account_id := ensure_donor_account(NEW.name, NEW.phone);
  UPDATE accounts SET name_ur = NEW.name_ur WHERE id = v_account_id AND name_ur IS DISTINCT FROM NEW.name_ur;

  DELETE FROM ledger_entries WHERE reference_type = 'donation' AND reference_id = NEW.id;

  IF NOT NEW.is_verified THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project_title FROM projects WHERE id = NEW.project_id;
  v_particular := 'Donation'
    || CASE WHEN v_project_title IS NOT NULL THEN ' - ' || v_project_title ELSE '' END
    || CASE WHEN NEW.fund_type <> 'general' THEN ' (' || upper(NEW.fund_type) || ')' ELSE '' END;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
  VALUES (v_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);

  SELECT id INTO v_cash_account_id FROM accounts
  WHERE system = 'donors_projects' AND code = (CASE WHEN NEW.payment_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END) AND tenant_id = NEW.tenant_id;
  IF v_cash_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_cash_account_id, NEW.date, v_particular, NEW.amount_pkr, 0, 'donation', NEW.id);
  END IF;

  IF NEW.project_id IS NOT NULL THEN
    v_project_account_id := ensure_project_account(NEW.project_id);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
    VALUES (v_project_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
  END IF;

  IF NEW.fund_type <> 'general' THEN
    v_fund_account_id := fund_account_id(NEW.fund_type);
    IF v_fund_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id)
      VALUES (v_fund_account_id, NEW.date, v_particular, 0, NEW.amount_pkr, 'donation', NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

create or replace function public.trg_donor_project_comment()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_display_name text;
  v_body text;
BEGIN
  IF NEW.project_id IS NULL THEN RETURN NEW; END IF;
  v_display_name := CASE WHEN NEW.is_anonymous THEN 'An anonymous donor' ELSE NEW.name END;
  IF NEW.payment_status = 'pledged' THEN
    v_body := v_display_name || ' announced a pledge of Rs. ' || to_char(NEW.amount_pkr, 'FM999999999') || '.';
  ELSE
    v_body := v_display_name || ' submitted a donation of Rs. ' || to_char(NEW.amount_pkr, 'FM999999999') || ', pending verification.';
  END IF;
  INSERT INTO project_comments (project_id, comment_type, system_label, content, tenant_id)
  VALUES (NEW.project_id, 'system', 'Donation System', v_body, NEW.tenant_id);
  RETURN NEW;
END;
$function$;

create or replace function public.trg_project_task_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_project varchar;
BEGIN
  IF NEW.portal_user_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.portal_user_id IS NOT DISTINCT FROM OLD.portal_user_id
     AND NEW.title IS NOT DISTINCT FROM OLD.title THEN
    RETURN NEW;
  END IF;

  SELECT title INTO v_project FROM projects WHERE id = NEW.project_id;
  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link, tenant_id)
  VALUES (NEW.portal_user_id, 'project_task_assigned',
          'New task: ' || NEW.title,
          COALESCE(v_project, 'Project') || COALESCE(' — due ' || to_char(NEW.due_date, 'DD/MM/YYYY'), ''),
          '/portal/my-volunteering', NEW.tenant_id);
  RETURN NEW;
END;
$function$;

create or replace function public.trg_training_enrollment_requested()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  proj projects%ROWTYPE;
  v_popup_enabled boolean;
  r record;
BEGIN
  IF NEW.status = 'pending' THEN
    SELECT * INTO proj FROM projects WHERE id = NEW.project_id;
    SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'training_enrollment_requested' AND tenant_id = proj.tenant_id;
    IF v_popup_enabled IS TRUE THEN
      FOR r IN
        SELECT id FROM admin_users
        WHERE is_active = true AND tenant_id = proj.tenant_id AND (
          (COALESCE(can_manage_parties, false) AND access_donors_projects)
          OR NEW.project_id = ANY(assigned_training_program_ids)
        )
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link, tenant_id)
        VALUES (r.id, 'training_enrollment_requested', 'New join request',
          NEW.student_name || ' requested a seat in ' || COALESCE(proj.display_name, proj.title),
          '/admin/academy-fees?project=' || NEW.project_id, proj.tenant_id);
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

create or replace function public.wazifa_check_zakat_family(p_father_name character varying, p_mother_name character varying DEFAULT NULL::character varying, p_declared_cnic character varying DEFAULT NULL::character varying)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'register_id', id, 'code', code, 'head_name', head_name, 'father_husband_name', father_husband_name,
    'asnaf_category', asnaf_category, 'phone', phone, 'address', address,
    'match_strength', match_strength
  ) ORDER BY match_strength DESC), '[]'::jsonb)
  FROM (
    SELECT id, code, head_name, father_husband_name, asnaf_category, phone, address,
      CASE
        WHEN p_declared_cnic IS NOT NULL AND cnic IS NOT NULL AND trim(cnic) = trim(p_declared_cnic) THEN 3
        WHEN lower(trim(head_name)) = lower(trim(COALESCE(p_father_name, ''))) THEN 2
        WHEN lower(trim(COALESCE(father_husband_name, ''))) = lower(trim(COALESCE(p_father_name, ''))) THEN 2
        WHEN p_mother_name IS NOT NULL AND lower(trim(head_name)) = lower(trim(p_mother_name)) THEN 2
        WHEN p_father_name IS NOT NULL AND head_name ILIKE '%' || p_father_name || '%' THEN 1
        WHEN p_father_name IS NOT NULL AND father_husband_name ILIKE '%' || p_father_name || '%' THEN 1
        ELSE 0
      END AS match_strength
    FROM needs_register
    WHERE tenant_id = my_tenant_id()
      AND status = 'verified'
      AND (
        (p_declared_cnic IS NOT NULL AND cnic = p_declared_cnic)
        OR (p_father_name IS NOT NULL AND (head_name ILIKE '%' || p_father_name || '%' OR father_husband_name ILIKE '%' || p_father_name || '%'))
        OR (p_mother_name IS NOT NULL AND head_name ILIKE '%' || p_mother_name || '%')
      )
  ) x
  WHERE match_strength > 0;
$function$;

create or replace function public.wazifa_confirm_zakat_match(p_student_id uuid, p_register_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF p_register_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM needs_register WHERE id = p_register_id AND tenant_id = my_tenant_id()) THEN
    RAISE EXCEPTION 'Household not found on the register.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE wazifa_students
     SET is_zakat_family = (p_register_id IS NOT NULL),
         zakat_match_register_id = p_register_id,
         zakat_match_confirmed_by = current_admin_user_id(),
         zakat_match_confirmed_at = now()
   WHERE id = p_student_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student not found' USING ERRCODE = 'P0001'; END IF;

  RETURN jsonb_build_object('ok', true, 'is_zakat_family', p_register_id IS NOT NULL);
END;
$function$;

create or replace function public.wazifa_family_check(p_father_name character varying, p_phone character varying DEFAULT NULL::character varying, p_cnic character varying DEFAULT NULL::character varying)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'wazifa_students', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', s.code, 'name', s.full_name, 'status', s.status,
        'awarded', (SELECT COALESCE(SUM(awarded_amount_pkr), 0) FROM wazifa_awards w
                     WHERE w.student_id = s.id AND w.status IN ('active', 'completed'))
      )), '[]'::jsonb)
      FROM wazifa_students s
      WHERE s.tenant_id = my_tenant_id()
        AND ((nullif(trim(p_father_name), '') IS NOT NULL AND lower(trim(s.father_name)) = lower(trim(p_father_name)))
         OR (nullif(trim(p_phone), '') IS NOT NULL AND s.phone = trim(p_phone))
         OR (nullif(trim(p_cnic), '') IS NOT NULL AND s.cnic = trim(p_cnic)))
    ),
    'kafalat_children', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', c.code, 'name', c.first_name, 'status', c.status
      )), '[]'::jsonb)
      FROM kafalat_children c
      WHERE c.tenant_id = my_tenant_id()
        AND nullif(trim(p_father_name), '') IS NOT NULL
        AND (lower(trim(c.guardian_name)) = lower(trim(p_father_name))
             OR (nullif(trim(p_phone), '') IS NOT NULL AND c.guardian_phone = trim(p_phone)))
    ),
    'needs_register', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('code', n.code, 'status', n.status)), '[]'::jsonb)
      FROM needs_register n
      WHERE n.tenant_id = my_tenant_id()
        AND ((nullif(trim(p_phone), '') IS NOT NULL AND n.phone = trim(p_phone))
         OR (nullif(trim(p_cnic), '') IS NOT NULL AND n.cnic = trim(p_cnic))
         OR (nullif(trim(p_father_name), '') IS NOT NULL
             AND lower(trim(n.father_husband_name)) = lower(trim(p_father_name))))
    )
  );
$function$;

create or replace function public.zakat_freeze_round(p_round_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  r zakat_rounds%ROWTYPE;
  v_count int;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM zakat_rounds WHERE id = p_round_id AND tenant_id = my_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found' USING ERRCODE = 'P0001'; END IF;
  IF r.status <> 'open' THEN
    RAISE EXCEPTION 'Only an open round can be frozen — this one is %.', r.status USING ERRCODE = 'P0001';
  END IF;

  PERFORM expire_needs_register();

  INSERT INTO zakat_round_beneficiaries (round_id, register_id, code, household_size, dependants, asnaf_category)
  SELECT p_round_id, n.id, n.code, n.household_size, n.dependants, n.asnaf_category
    FROM needs_register n
   WHERE n.status = 'verified' AND n.tenant_id = r.tenant_id
  ON CONFLICT (round_id, register_id) DO NOTHING;

  SELECT count(*) INTO v_count FROM zakat_round_beneficiaries WHERE round_id = p_round_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No verified households on the register — nothing to distribute to.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE zakat_rounds
     SET status = 'frozen', frozen_at = now(), household_count = v_count
   WHERE id = p_round_id;

  RETURN jsonb_build_object('households', v_count);
END;
$function$;

create or replace function public.zakat_round_report(p_round_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT jsonb_build_object(
    'name', r.name, 'name_ur', r.name_ur, 'fund_type', r.fund_type,
    'status', r.status, 'distribution_date', r.distribution_date,
    'formula', jsonb_build_object(
      'base_per_household', r.base_per_household,
      'per_dependant_increment', r.per_dependant_increment,
      'note', r.formula_note),
    'collected', r.collected_pkr,
    'distributed', r.distributed_pkr,
    'households', r.household_count,
    'paid_households', (SELECT count(*) FROM zakat_round_beneficiaries WHERE round_id = r.id AND status = 'paid'),
    'widow_headed', (SELECT count(*) FROM zakat_round_beneficiaries b JOIN needs_register n ON n.id = b.register_id
                      WHERE b.round_id = r.id AND n.is_widow_headed),
    'with_orphans', (SELECT count(*) FROM zakat_round_beneficiaries b JOIN needs_register n ON n.id = b.register_id
                      WHERE b.round_id = r.id AND n.has_orphans),
    'by_category', (SELECT jsonb_object_agg(asnaf_category, c) FROM
                     (SELECT asnaf_category, count(*) c FROM zakat_round_beneficiaries
                       WHERE round_id = r.id GROUP BY asnaf_category) x),
    'verifiers', (SELECT COALESCE(jsonb_agg(DISTINCT a.full_name), '[]'::jsonb)
                    FROM needs_verifications v JOIN admin_users a ON a.id = v.admin_user_id
                   WHERE v.register_id IN (SELECT register_id FROM zakat_round_beneficiaries WHERE round_id = r.id))
  ) FROM zakat_rounds r WHERE r.id = p_round_id AND r.tenant_id = my_tenant_id();
$function$;
