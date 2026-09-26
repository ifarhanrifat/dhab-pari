-- Real ask, 2026-09-25: admin_users.email is a plain mirror column (used
-- for display, and was set once at invite/create time) -- nothing kept it
-- in sync with the real Supabase Auth identity (auth.users.email). Adding
-- self-service "change my email" (supabase.auth.updateUser({ email })) on
-- the new /admin/profile page updates the AUTH identity once the admin
-- confirms the link Supabase emails to the new address -- but that
-- confirmation happens asynchronously, outside any request this app's own
-- API routes control, so the mirror column would otherwise silently go
-- stale the moment someone actually changes their email. A trigger on
-- auth.users is the only place that's guaranteed to fire exactly when the
-- confirmed email actually changes, regardless of how (this flow, a future
-- admin-invite flow, or a manual dashboard edit).
CREATE OR REPLACE FUNCTION sync_admin_user_email() RETURNS trigger AS $$
BEGIN
  UPDATE admin_users SET email = NEW.email WHERE auth_user_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth;

DROP TRIGGER IF EXISTS trg_sync_admin_user_email ON auth.users;
CREATE TRIGGER trg_sync_admin_user_email
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION sync_admin_user_email();
