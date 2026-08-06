-- Migration 130: Signup/profile fields requested after live review —
-- donor type (villager/overseas + country when overseas), sector, and an
-- avatar. Required-ness (name/father's name/donor_type) is enforced at the
-- API route + RLS-adjacent application layer, not a DB NOT NULL, since
-- existing rows may not have these set and a hard constraint would break them.

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS donor_type varchar DEFAULT 'villager' CHECK (donor_type IN ('villager', 'overseas')),
  ADD COLUMN IF NOT EXISTS country varchar,
  ADD COLUMN IF NOT EXISTS sector varchar,
  ADD COLUMN IF NOT EXISTS avatar_url text;
