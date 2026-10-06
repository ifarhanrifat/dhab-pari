-- CRITICAL SECURITY FIX: 17 more views discovered via a full audit of
-- every view in the public schema, following on from the 4 found and
-- fixed in Phase 2 slice 6 (donors_public, project_expenses_public,
-- project_accounts_public, project_comments_public). Every view in this
-- schema is owned by `postgres` with no `security_invoker`, so every one
-- of them runs with the owner's privileges and bypasses RLS on its
-- underlying tables entirely -- and all 17 here are granted SELECT to
-- `anon` and/or `authenticated` directly, same as the first 4.
--
-- The two most severe: ledger_account_balances and ledger_monthly_by_account
-- expose every account's full debit/credit ledger totals -- actual
-- financial data -- to any anonymous internet visitor with zero
-- authentication at all, mixing every tenant's books into one
-- unfiltered result set. needs_register_safe exposes welfare-registry
-- household composition (asnaf category, orphan/disability counts,
-- housing, land ownership, BISP/zakat receipt) across every tenant, with
-- no tenant filter, also to anon/authenticated directly.
--
-- Every other view here is a "public" counterpart view (achievements,
-- chanda campaigns/pledges, event salami accounts, mentor directory,
-- the *_comments_public/*_supporters_public/*_votes_public/volunteers_public
-- family) with the identical shape as the 4 already fixed: a public
-- browse surface with no tenant filter on any of its source tables.
--
-- Fixed the same way as the first 4: coalesce(my_tenant_id(), <dhab-pari>)
-- on every underlying table, so anon still sees dhab-pari's own public
-- content (preserving current behaviour) while an authenticated user of
-- any other tenant sees their own tenant's content instead of every
-- tenant's mixed together.
--
-- mentor_conversations_with_names is the one exception to the "public
-- browse" shape: its own/participant branches are already tenant-safe
-- (current_portal_user_id() ownership), but its admin-bypass branch
-- (current_admin_role() IN ('super_admin','admin')) had no tenant check
-- at all -- an admin on any tenant could see every tenant's mentor
-- conversations through that branch. Fixed with my_tenant_id() on the
-- admin branch specifically (strict, not coalesce, since this view has
-- no anon grant and the admin branch should only ever match the admin's
-- own tenant).

create or replace view ledger_account_balances as
select account_id, sum(debit) as total_debit, sum(credit) as total_credit
from ledger_entries
where account_id in (select id from accounts where tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
group by account_id;

create or replace view ledger_monthly_by_account as
select account_id, date_trunc('month', entry_date::timestamp with time zone)::date as month,
       sum(debit) as total_debit, sum(credit) as total_credit
from ledger_entries
where account_id in (select id from accounts where tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
group by account_id, (date_trunc('month', entry_date::timestamp with time zone));

create or replace view needs_register_safe as
select id, code, asnaf_category, status, household_size, dependants, earning_members,
       is_widow_headed, has_orphans, orphan_count, has_disabled_member, school_age_children,
       housing, owns_land, receives_bisp, receives_govt_zakat, verified_at, verified_until,
       source, created_at,
       (select count(*) from needs_verifications v where v.register_id = r.id and v.decision::text = 'verify'::text) as verify_count
from needs_register r
where r.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view achievements_public as
select ai.id, ai.text_ur, ai.done_at, ai.is_private,
       case when ai.is_private then null::character varying else au.full_name end as done_by_name,
       'meeting'::character varying as source
from agenda_items ai
left join admin_users au on au.id = ai.done_by_admin_user_id
where ai.status::text = 'done'::text
  and ai.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
union all
select m.id, m.text_ur, m.occurred_at as done_at, false as is_private,
       au.full_name as done_by_name, 'manual'::character varying as source
from manual_achievements m
left join admin_users au on au.id = m.added_by
where m.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
union all
select p.id,
       ('منصوبہ "'::text || coalesce(p.title_ur, p.title)::text) || '" مکمل ہو گیا۔'::text as text_ur,
       p.completed_at as done_at, false as is_private, null::character varying as done_by_name,
       'project'::character varying as source
from projects p
where p.status::text = 'completed'::text and p.completed_at is not null
  and p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
union all
select ts.id,
       ('کمیونٹی نے "'::text || ts.display_name::text) || '" کی ضرورت پوری کر دی۔'::text as text_ur,
       ts.fulfilled_at as done_at, false as is_private,
       (select string_agg(s.name::text, '، '::text order by s.created_at) from talent_showcase_supporters s where s.talent_showcase_id = ts.id) as done_by_name,
       'talent'::character varying as source
from talent_showcases ts
where ts.support_status::text = 'fulfilled'::text and ts.fulfilled_at is not null and ts.is_published = true
  and ts.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
order by 3 desc;

create or replace view chanda_campaigns_public as
select id, type, directory_entry_id, title, title_ur, description, description_ur,
       target_amount, payment_method, account_number, account_title, bank_name,
       display_until, cover_image_url
from chanda_campaigns
where is_active = true and display_until > now()
  and tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view chanda_pledges_public as
select id, campaign_id,
       case when is_anonymous then 'Anonymous'::character varying else giver_name end as giver_name,
       amount, status, created_at, confirmed_at
from chanda_pledges
where tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view donor_badges_admin as
select p.id as portal_user_id, p.full_name, p.name_ur, p.username, p.mobile, p.manual_badge_tier,
       donor_badge_tier(p.id) as badge_tier,
       coalesce((select sum(le.credit) - sum(le.debit) from ledger_entries le where le.account_id = p.donor_account_id), 0::numeric) as total_donated_pkr
from portal_users p
where p.is_active = true and (p.donor_account_id is not null or p.manual_badge_tier is not null)
  and p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view event_salami_accounts_public as
select id, event_id, side, family_name, payment_method, account_number, account_title, bank_name
from event_salami_accounts
where tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view event_salami_totals as
select event_id, side, status, coalesce(sum(amount), 0::numeric) as total_amount, count(*) as pledge_count
from event_salami_pledges
where tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
group by event_id, side, status;

create or replace view mentor_conversations_with_names as
select c.id, c.student_portal_user_id, c.mentor_portal_user_id, c.status, c.created_at,
       c.last_message_at, c.student_last_read_at, c.mentor_last_read_at,
       portal_public_name(s.id) as student_name, s.avatar_url as student_avatar_url,
       portal_public_name(m.id) as mentor_name, m.avatar_url as mentor_avatar_url,
       m.mentor_type, m.mentor_expertise, m.mentor_bio
from mentor_conversations c
join portal_users s on s.id = c.student_portal_user_id
join portal_users m on m.id = c.mentor_portal_user_id
where c.student_portal_user_id = current_portal_user_id()
   or c.mentor_portal_user_id = current_portal_user_id()
   or (c.tenant_id = my_tenant_id() and current_admin_role()::text = any (array['super_admin'::character varying, 'admin'::character varying]::text[]));

create or replace view mentor_directory as
select id, portal_public_name(id) as full_name, avatar_url, mentor_type, mentor_bio, mentor_expertise, mentor_available
from portal_users
where mentor_status::text = 'approved'::text and is_active = true
  and tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view news_comments_public as
select c.id, c.news_post_id, c.parent_comment_id, c.comment_type, c.content, c.created_at,
       c.portal_user_id, c.admin_user_id,
       case when c.comment_type::text = 'staff'::text then a.full_name else portal_public_name(p.id) end as username,
       case when c.comment_type::text = 'staff'::text then null::text else p.avatar_url end as avatar_url,
       case when c.comment_type::text = 'staff'::text then null::character varying else donor_badge_tier(p.id) end as badge_tier,
       case when c.comment_type::text = 'staff'::text then a.role else null::character varying end as staff_role
from news_comments c
left join portal_users p on p.id = c.portal_user_id
left join admin_users a on a.id = c.admin_user_id
where c.is_hidden = false
  and c.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view project_income_public as
select a.project_id, le.id, le.entry_date, le.particular, le.credit
from ledger_entries le
join accounts a on a.id = le.account_id
join projects p on p.id = a.project_id
left join vouchers v on le.reference_type::text = 'voucher'::text and v.id = le.reference_id
where a.project_id is not null and le.credit > 0::numeric and p.is_private = false and p.hide_donations = false
  and (v.id is null or v.reverses_voucher_id is null and v.reversed_by_voucher_id is null)
  and p.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view project_votes_public as
select v.id, v.project_id, v.created_at, p.username, p.avatar_url
from project_votes v
join portal_users p on p.id = v.portal_user_id
where v.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view talent_showcase_comments_public as
select c.id, c.talent_showcase_id, c.content, c.created_at, c.portal_user_id,
       portal_public_name(p.id) as username, p.avatar_url, donor_badge_tier(p.id) as badge_tier,
       (select count(*) from talent_showcase_comment_likes l where l.comment_id = c.id) as like_count
from talent_showcase_comments c
join portal_users p on p.id = c.portal_user_id
where c.is_hidden = false
  and c.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view talent_showcase_supporters_public as
select s.id, s.talent_showcase_id, s.name, s.created_at
from talent_showcase_supporters s
where exists (select 1 from talent_showcases t where t.id = s.talent_showcase_id and t.is_published = true)
  and s.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

create or replace view volunteers_public as
select v.id, v.project_id, v.message, v.status, v.created_at,
       portal_public_name(p.id) as full_name, p.avatar_url
from volunteers v
join portal_users p on p.id = v.portal_user_id
where v.tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
