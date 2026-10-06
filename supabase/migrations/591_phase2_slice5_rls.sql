-- Phase 2, slice 5 (RLS): same uniform transformation as prior slices --
-- prepend `tenant_id = my_tenant_id() AND` to every USING/CHECK. No
-- genuinely anonymous-readable policy exists on these 7 tables (even
-- notifications_log's {public}-role policy requires auth.role() =
-- 'authenticated'), so every policy uses plain my_tenant_id(), no
-- hardcoded-tenant fallback needed this slice. portal_signup_verifications
-- has RLS enabled with zero policies (accessed only via SECURITY DEFINER
-- functions), so there's nothing to alter there.

alter policy "fcm_device_tokens_admin_own" on fcm_device_tokens
  using ((tenant_id = my_tenant_id()) AND ((admin_user_id = current_admin_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((admin_user_id = current_admin_user_id())));

alter policy "fcm_device_tokens_portal_own" on fcm_device_tokens
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "notification_preferences_read" on notification_preferences
  using ((tenant_id = my_tenant_id()) AND (true));

alter policy "notification_preferences_write" on notification_preferences
  using ((tenant_id = my_tenant_id()) AND (current_admin_is_admin_tier()))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_is_admin_tier()));

alter policy "notifications_read_own" on notifications
  using ((tenant_id = my_tenant_id()) AND ((recipient_id = current_admin_user_id())));

alter policy "notifications_update_own" on notifications
  using ((tenant_id = my_tenant_id()) AND ((recipient_id = current_admin_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((recipient_id = current_admin_user_id())));

alter policy "admin_all_notifications" on notifications_log
  using ((tenant_id = my_tenant_id()) AND ((auth.role() = 'authenticated'::text)));

alter policy "portal_notifications_delete_own" on portal_notifications
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "portal_notifications_read_own" on portal_notifications
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "portal_notifications_update_own" on portal_notifications
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "push_subscriptions_admin_own" on push_subscriptions
  using ((tenant_id = my_tenant_id()) AND ((admin_user_id = current_admin_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((admin_user_id = current_admin_user_id())));

alter policy "push_subscriptions_portal_own" on push_subscriptions
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

-- 12 policies total
