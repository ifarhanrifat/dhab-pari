-- Migration 348: Real Web Push — a notification lands on the phone even
-- when nobody has the site open, the way a native app's notifications do.
-- No new backend service: the browser's own push infrastructure (Chrome's,
-- Apple's) delivers it; this migration only adds where a device's push
-- subscription is stored and how Postgres tells our own API route "a new
-- notification just landed, go deliver it."
--
-- The actual push (constructing the encrypted, VAPID-signed request the Web
-- Push protocol requires) happens in Node — pg_net can reach the API route,
-- but the cryptography itself is squarely a job for the `web-push` library,
-- not hand-rolled SQL.
--
-- The two secrets dispatch_push_notification() reads (push_api_url,
-- push_trigger_secret) are deliberately NOT set here — a migration file is
-- committed to git, and a secret has no business in git history even inside
-- a vault.create_secret() call. They're inserted once, directly against the
-- live database, outside of any migration file.

CREATE EXTENSION IF NOT EXISTS pg_net;

-- One row per device/browser a person has said yes on. A person can have
-- several (phone + laptop) — exactly one of the two owner columns is set,
-- matching every other admin_users/portal_users dual-audience pattern in
-- this app.
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((admin_user_id IS NOT NULL) <> (portal_user_id IS NOT NULL))
);
CREATE INDEX push_subscriptions_admin_idx ON push_subscriptions(admin_user_id) WHERE admin_user_id IS NOT NULL;
CREATE INDEX push_subscriptions_portal_idx ON push_subscriptions(portal_user_id) WHERE portal_user_id IS NOT NULL;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Subscribing/unsubscribing is a plain table operation from the client (no
-- API route needed for this half) — same self-service pattern as
-- notification_preferences elsewhere in this app. Upsert-by-endpoint on the
-- client means re-subscribing on the same device/browser just updates the
-- existing row rather than erroring on the UNIQUE constraint.
CREATE POLICY "push_subscriptions_admin_own" ON push_subscriptions FOR ALL TO authenticated
  USING (admin_user_id = current_admin_user_id())
  WITH CHECK (admin_user_id = current_admin_user_id());
CREATE POLICY "push_subscriptions_portal_own" ON push_subscriptions FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());

-- Fired after INSERT on notifications/portal_notifications. Fire-and-forget
-- by design (net.http_post queues the request async and returns
-- immediately) — a slow or failed push must never hold up or fail the
-- notification insert itself, which is the actual source of truth the
-- in-app bell already reads from regardless of whether the push arrives.
CREATE OR REPLACE FUNCTION dispatch_push_notification() RETURNS trigger AS $$
DECLARE
  v_url text;
  v_secret text;
  v_table text := TG_TABLE_NAME;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'push_api_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'push_trigger_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('table', v_table, 'id', NEW.id)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a push-dispatch problem block the notification itself.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, net;

DROP TRIGGER IF EXISTS trg_dispatch_push_admin ON notifications;
CREATE TRIGGER trg_dispatch_push_admin AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION dispatch_push_notification();

DROP TRIGGER IF EXISTS trg_dispatch_push_portal ON portal_notifications;
CREATE TRIGGER trg_dispatch_push_portal AFTER INSERT ON portal_notifications
  FOR EACH ROW EXECUTE FUNCTION dispatch_push_notification();
