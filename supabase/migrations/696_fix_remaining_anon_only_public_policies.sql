-- Migration 696: same real bug as video_content (695), audited across
-- the whole schema. Every other "public read" policy in this app
-- already follows a deliberate anon+authenticated pair (e.g.
-- important_contacts has both public_read_active_contacts AND
-- authenticated_read_active_contacts) -- video_content was just
-- missing its other half. A targeted audit found exactly three more
-- tables with the identical gap: a public-facing anon-only read
-- policy and zero authenticated-role policy of any kind at all,
-- meaning any logged-in user (portal or admin) has never been able to
-- read these either. Mirroring each table's own anon condition
-- exactly, same as every other pair in this schema already does.

CREATE POLICY authenticated_read_active_members ON committee_members
  FOR SELECT TO authenticated
  USING (
    tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND is_active = true
  );

CREATE POLICY authenticated_read_active_directory_entries ON directory_entries
  FOR SELECT TO authenticated
  USING (
    tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
    AND is_active = true
  );

CREATE POLICY authenticated_read_transactions ON transactions
  FOR SELECT TO authenticated
  USING (
    tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)
  );
