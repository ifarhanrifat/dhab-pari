-- Migration 078: Manual user creation bridge — invite/reset-password emails
-- aren't working (Supabase free-tier limits), so this lets a super admin
-- create a login directly with a chosen password, and view/reset it later,
-- until the email configuration is fixed and this gets removed.
--
-- Deliberately a SEPARATE table from admin_users: admin_users is readable by
-- any admin-tier user (read_admin_users policy, migration 066), not just
-- super_admin, and RLS is row-level only — a column added directly to
-- admin_users would have been visible to every admin, not just super admins.
-- This table's own RLS is what actually restricts who can see a password.
CREATE TABLE IF NOT EXISTS admin_user_credentials (
  admin_user_id uuid PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  password varchar NOT NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE admin_user_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_user_credentials_read" ON admin_user_credentials FOR SELECT TO authenticated
  USING (current_admin_is_super_admin());
-- No client INSERT/UPDATE/DELETE policy — only the service-role API routes
-- (create-manual, set-password) ever write here.
