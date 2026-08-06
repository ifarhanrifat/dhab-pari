-- Migration 132: 'role_request' suggestion type — portal users requesting
-- the publisher role (writing/photography/design skills) via the portal.
-- Reuses the existing suggestions table/RLS entirely (already publicly
-- insertable, already has portal_user_id + a read-own policy from migration
-- 122) — staff review and grant the role manually via existing User
-- Management, same as any other suggestion; no auto-granting.
ALTER TABLE suggestions DROP CONSTRAINT IF EXISTS suggestions_type_check;
ALTER TABLE suggestions ADD CONSTRAINT suggestions_type_check
  CHECK (type IN ('suggestion', 'volunteer', 'complaint', 'general', 'role_request'));
