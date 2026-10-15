-- Migration 669: give marketplace_share_agreements.owner_tenant_id the
-- same smart default every other tenant-scoped table in this schema
-- already has, so the admin UI can insert a new share agreement without
-- a separate round-trip just to look up its own tenant_id first.
ALTER TABLE marketplace_share_agreements ALTER COLUMN owner_tenant_id SET DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
