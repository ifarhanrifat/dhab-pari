-- Migration 320: portal_users had a read policy for super_admin/admin
-- (migration 121) but no matching UPDATE policy — only a person's own row,
-- via portal_users_update_own. The new Portal Accounts admin page needs to
-- block/unblock accounts and correct a mislinked consumer/donor account,
-- so admin/super_admin get the same UPDATE reach they already have SELECT
-- reach for.
CREATE POLICY "portal_users_admin_update" ON portal_users FOR UPDATE TO authenticated
  USING (current_admin_role() IN ('super_admin', 'admin'))
  WITH CHECK (current_admin_role() IN ('super_admin', 'admin'));
