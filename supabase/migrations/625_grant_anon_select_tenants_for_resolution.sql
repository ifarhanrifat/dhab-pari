-- Migration 616 revoked SELECT on tenants from anon entirely (correctly,
-- at the time — the table had no RLS at all). Migration 624 added RLS
-- back for anon narrowly (tenants_public_resolve: only active tenants,
-- no columns restricted beyond what RLS allows row-wise) so that
-- middleware.ts can resolve a subdomain's slug to its tenant id. RLS
-- policies are irrelevant without the underlying table grant -- this
-- restores just the SELECT grant anon needs, now safely gated by RLS.
grant select on tenants to anon;
