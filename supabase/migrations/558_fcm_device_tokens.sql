-- Migration 558: native push (FCM) device tokens -- 2026-10-01.
--
-- Real gap found testing the Android app: push_subscriptions (348) is Web
-- Push (browser PushManager) -- it can't deliver in the background through
-- the Android app's bare WebView, only a real browser tab. The native
-- equivalent is Firebase Cloud Messaging, which needs its own token shape
-- (a single opaque string, not a Web Push endpoint+p256dh+auth keypair),
-- hence a separate table rather than reusing push_subscriptions.
--
-- Same dual-owner / self-managed pattern as push_subscriptions.
CREATE TABLE fcm_device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((admin_user_id IS NOT NULL) <> (portal_user_id IS NOT NULL))
);
CREATE INDEX fcm_device_tokens_admin_idx ON fcm_device_tokens(admin_user_id) WHERE admin_user_id IS NOT NULL;
CREATE INDEX fcm_device_tokens_portal_idx ON fcm_device_tokens(portal_user_id) WHERE portal_user_id IS NOT NULL;

ALTER TABLE fcm_device_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fcm_device_tokens_admin_own" ON fcm_device_tokens FOR ALL TO authenticated
  USING (admin_user_id = current_admin_user_id())
  WITH CHECK (admin_user_id = current_admin_user_id());
CREATE POLICY "fcm_device_tokens_portal_own" ON fcm_device_tokens FOR ALL TO authenticated
  USING (portal_user_id = current_portal_user_id())
  WITH CHECK (portal_user_id = current_portal_user_id());
