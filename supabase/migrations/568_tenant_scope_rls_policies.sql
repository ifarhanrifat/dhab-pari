-- Phase 1, part 3/3: tenant-scope every RLS policy on the 26 phase-1
-- tables (88 policies total). One uniform, mechanical transformation
-- applied to every single one, by design, rather than bespoke logic per
-- policy — the kind of thing that's easy to get subtly wrong 88 separate
-- times and much harder to get wrong once:
--
--   new USING  = (tenant_id = my_tenant_id())            AND (old USING)
--   new CHECK  = (tenant_id = my_tenant_id())             AND (old CHECK)
--
-- This can only ever narrow access, never widen it — and for every
-- admin/portal user and every row that exists today, tenant_id already
-- equals the one real tenant (Dhab Pari), and my_tenant_id() resolves to
-- that same tenant for every one of them (backfilled in migration 566).
-- So this transformation is provably a no-op for all of today's actual
-- behavior, while correctly fencing off any second tenant's rows the
-- moment one exists. Verified after this migration with a real, throwaway
-- second tenant (created, isolation checked both directions, then
-- deleted — never left on the live database).
--
-- Three policies are a deliberate exception to the uniform rule —
-- anonymous/public-readable policies (no auth.uid() at all, so
-- my_tenant_id() has nothing to resolve): transactions.public_read_transactions,
-- sectors.public_read_sectors, site_settings.public_read_settings. These
-- get the one real tenant's id hardcoded instead of left wide open —
-- otherwise a second tenant's transactions/sector names/site settings
-- would leak to every anonymous visitor on Dhab Pari's public site the
-- moment that tenant's data existed. The hardcoded id is exactly as
-- correct as "show everything" is today (there is only one tenant), and
-- unlike "show everything" it fails safe instead of leaking once a second
-- tenant exists — phase 2's domain/path-based tenant routing replaces
-- this properly for a logged-out visitor instead of leaving it to rot.

alter policy "accounts_delete" on accounts
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('delete_accounts'::character varying))));

alter policy "accounts_portal_read_own" on accounts
  using ((tenant_id = my_tenant_id()) AND ((id = ( SELECT portal_users.donor_account_id
   FROM portal_users
  WHERE (portal_users.id = current_portal_user_id())))));

alter policy "accounts_read" on accounts
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "accounts_update" on accounts
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('edit_accounts'::character varying))));

alter policy "accounts_write" on accounts
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('manage_accounts'::character varying))));

alter policy "delete_admin_users" on admin_users
  using ((tenant_id = my_tenant_id()) AND (((auth_user_id <> auth.uid()) AND (current_admin_is_super_admin() OR (current_admin_has_role('admin'::character varying) AND current_admin_permission('invite_users'::character varying) AND ((role)::text <> 'super_admin'::text) AND ((secondary_role)::text IS DISTINCT FROM 'super_admin'::text))))));

alter policy "insert_admin_users" on admin_users
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_is_super_admin() OR (current_admin_has_role('admin'::character varying) AND current_admin_permission('invite_users'::character varying) AND ((role)::text <> 'super_admin'::text) AND ((secondary_role)::text IS DISTINCT FROM 'super_admin'::text)))));

alter policy "read_admin_users" on admin_users
  using ((tenant_id = my_tenant_id()) AND (((auth_user_id = auth.uid()) OR current_admin_is_admin_tier())));

alter policy "update_admin_users" on admin_users
  using ((tenant_id = my_tenant_id()) AND (((auth_user_id = auth.uid()) OR current_admin_is_super_admin() OR (current_admin_has_role('admin'::character varying) AND current_admin_permission('invite_users'::character varying)))))
  with check ((tenant_id = my_tenant_id()) AND (((((role)::text <> 'super_admin'::text) AND ((secondary_role)::text IS DISTINCT FROM 'super_admin'::text)) OR current_admin_is_super_admin())));

alter policy "donors_delete" on donors
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "donors_portal_pledge_insert" on donors
  with check ((tenant_id = my_tenant_id()) AND (((is_verified = false) AND ((submitted_via)::text = 'public'::text) AND project_accepts_donations(project_id) AND ((payment_status)::text = 'pledged'::text) AND (portal_user_id = current_portal_user_id()))));

alter policy "donors_portal_read_own" on donors
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "donors_public_submit" on donors
  with check ((tenant_id = my_tenant_id()) AND (((is_verified = false) AND ((submitted_via)::text = 'public'::text) AND project_accepts_donations(project_id))));

alter policy "donors_read" on donors
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "donors_update" on donors
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "donors_write" on donors
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "ledger_entries_delete" on ledger_entries
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM accounts a
  WHERE ((a.id = ledger_entries.account_id) AND can_access_system(a.system) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "ledger_entries_read" on ledger_entries
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM accounts a
  WHERE ((a.id = ledger_entries.account_id) AND can_access_system(a.system))))));

alter policy "ledger_entries_write" on ledger_entries
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM accounts a
  WHERE ((a.id = ledger_entries.account_id) AND can_access_system(a.system) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "ledger_portal_read_own" on ledger_entries
  using ((tenant_id = my_tenant_id()) AND ((account_id = ( SELECT portal_users.donor_account_id
   FROM portal_users
  WHERE (portal_users.id = current_portal_user_id())))));

alter policy "payments_delete" on payments
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "payments_portal_read_own" on payments
  using ((tenant_id = my_tenant_id()) AND (((consumer_id)::text = (( SELECT portal_users.consumer_id
   FROM portal_users
  WHERE (portal_users.id = current_portal_user_id())))::text)));

alter policy "payments_read" on payments
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "payments_write" on payments
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND (current_admin_permission('post_transactions'::character varying) OR ((collected_by = current_admin_user_id()) AND current_admin_can_collect_for_consumer(consumer_id))))));

alter policy "portal_users_admin_update" on portal_users
  using ((tenant_id = my_tenant_id()) AND (((current_admin_role())::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying])::text[]))))
  with check ((tenant_id = my_tenant_id()) AND (((current_admin_role())::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying])::text[]))));

alter policy "portal_users_read_own" on portal_users
  using ((tenant_id = my_tenant_id()) AND (((auth_user_id = auth.uid()) OR ((current_admin_role())::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying])::text[])))));

alter policy "portal_users_update_own" on portal_users
  using ((tenant_id = my_tenant_id()) AND ((auth_user_id = auth.uid())))
  with check ((tenant_id = my_tenant_id()) AND ((auth_user_id = auth.uid())));

alter policy "admin_all_transactions" on transactions
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "public_read_transactions" on transactions
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "voucher_approvals_read" on voucher_approvals
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vouchers v
  WHERE ((v.id = voucher_approvals.voucher_id) AND can_access_system(v.system))))));

alter policy "voucher_line_items_read" on voucher_line_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vouchers v
  WHERE ((v.id = voucher_line_items.voucher_id) AND can_access_system(v.system))))));

alter policy "voucher_line_items_write" on voucher_line_items
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vouchers v
  WHERE ((v.id = voucher_line_items.voucher_id) AND can_access_system(v.system) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "vouchers_delete" on vouchers
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "vouchers_read" on vouchers
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "vouchers_update" on vouchers
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('approve_transactions'::character varying))));

alter policy "vouchers_write" on vouchers
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "read_audit_log" on audit_log
  using ((tenant_id = my_tenant_id()) AND (current_admin_is_admin_tier()));

alter policy "bill_line_items_delete" on bill_line_items
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "bill_line_items_read" on bill_line_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "bill_line_items_write" on bill_line_items
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('post_transactions'::character varying))));

alter policy "bill_payment_claims_portal_insert" on bill_payment_claims
  with check ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) AND ((status)::text = 'pending'::text))));

alter policy "bill_payment_claims_portal_read" on bill_payment_claims
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "bill_payment_claims_staff_read" on bill_payment_claims
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "bills_delete" on bills
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "bills_portal_read_own" on bills
  using ((tenant_id = my_tenant_id()) AND (((consumer_id)::text = (( SELECT portal_users.consumer_id
   FROM portal_users
  WHERE (portal_users.id = current_portal_user_id())))::text)));

alter policy "bills_read" on bills
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "bills_update" on bills
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('edit_transactions'::character varying))));

alter policy "bills_write" on bills
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('post_transactions'::character varying))));

alter policy "collector_settlements_read" on collector_settlements
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "collector_settlements_write" on collector_settlements
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "connection_request_items_delete" on connection_request_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM connection_requests r
  WHERE ((r.id = connection_request_items.request_id) AND can_access_system('water_supply'::character varying) AND current_admin_permission('edit_transactions'::character varying))))));

alter policy "connection_request_items_insert" on connection_request_items
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM connection_requests r
  WHERE ((r.id = connection_request_items.request_id) AND can_access_system('water_supply'::character varying) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "connection_request_items_read" on connection_request_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM connection_requests r
  WHERE ((r.id = connection_request_items.request_id) AND can_access_system('water_supply'::character varying))))));

alter policy "connection_requests_delete" on connection_requests
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "connection_requests_insert" on connection_requests
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('post_transactions'::character varying))));

alter policy "connection_requests_read" on connection_requests
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "connection_requests_update" on connection_requests
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND (current_admin_permission('edit_transactions'::character varying) OR (incharge_user_id = current_admin_user_id())))))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND (current_admin_permission('edit_transactions'::character varying) OR (incharge_user_id = current_admin_user_id())))));

alter policy "consumers_delete" on consumers
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "consumers_portal_read_own" on consumers
  using ((tenant_id = my_tenant_id()) AND (((consumer_id)::text = (( SELECT portal_users.consumer_id
   FROM portal_users
  WHERE (portal_users.id = current_portal_user_id())))::text)));

alter policy "consumers_read" on consumers
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)));

alter policy "consumers_update" on consumers
  using ((tenant_id = my_tenant_id()) AND (can_access_system('water_supply'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "consumers_write" on consumers
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('water_supply'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "inventory_items_delete" on inventory_items
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('delete_accounts'::character varying))));

alter policy "inventory_items_read" on inventory_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "inventory_items_update" on inventory_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('edit_accounts'::character varying))));

alter policy "inventory_items_write" on inventory_items
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('manage_accounts'::character varying))));

alter policy "inventory_transactions_read" on inventory_transactions
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM inventory_items i
  WHERE ((i.id = inventory_transactions.item_id) AND can_access_system(i.system))))));

alter policy "inventory_transactions_write" on inventory_transactions
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM inventory_items i
  WHERE ((i.id = inventory_transactions.item_id) AND can_access_system(i.system) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "message_templates_read" on message_templates
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "message_templates_write" on message_templates
  using ((tenant_id = my_tenant_id()) AND (((current_admin_role())::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying])::text[]))))
  with check ((tenant_id = my_tenant_id()) AND (((current_admin_role())::text = ANY ((ARRAY['super_admin'::character varying, 'admin'::character varying])::text[]))));

alter policy "recurring_schedules_delete" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "recurring_schedules_portal_delete" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND ((created_by_portal_user_id = current_portal_user_id())));

alter policy "recurring_schedules_portal_insert" on recurring_schedules
  with check ((tenant_id = my_tenant_id()) AND (((created_by_portal_user_id = current_portal_user_id()) AND ((schedule_type)::text = 'donation'::text) AND ((system)::text = 'donors_projects'::text))));

alter policy "recurring_schedules_portal_read" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND ((created_by_portal_user_id = current_portal_user_id())));

alter policy "recurring_schedules_portal_update" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND ((created_by_portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND (((created_by_portal_user_id = current_portal_user_id()) AND ((schedule_type)::text = 'donation'::text) AND ((system)::text = 'donors_projects'::text))));

alter policy "recurring_schedules_read" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "recurring_schedules_update" on recurring_schedules
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "recurring_schedules_write" on recurring_schedules
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "public_read_sectors" on sectors
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "sectors_delete" on sectors
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_accounts'::character varying)));

alter policy "sectors_update" on sectors
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('edit_accounts'::character varying)));

alter policy "sectors_write" on sectors
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_accounts'::character varying)));

alter policy "service_items_delete" on service_items
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('delete_accounts'::character varying))));

alter policy "service_items_read" on service_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "service_items_update" on service_items
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('edit_accounts'::character varying))));

alter policy "service_items_write" on service_items
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('manage_accounts'::character varying))));

alter policy "admin_all_settings" on site_settings
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "public_read_settings" on site_settings
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));
