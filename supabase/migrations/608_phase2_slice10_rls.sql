-- Phase 2, slice 10 (RLS): tenant-scope every policy on the 7 slice-10
-- tables. Authenticated-only policies get `tenant_id = my_tenant_id() AND`
-- prepended. Purely anonymous-readable policies get the hardcoded
-- dhab-pari literal, since each has a separate authenticated ALL policy
-- that already covers an admin's own-tenant visibility regardless of
-- published/active status. The one exception is news_comments_read
-- (same mixed-visibility shape as project_comments_read/talent_showcase_
-- comments_read from slices 6/8, with no separate staff-ALL-read fallback)
-- -- that one gets coalesce(my_tenant_id(), <dhab-pari>) instead.

alter policy gallery_albums_publish on gallery_albums
  using (my_tenant_id() = tenant_id and current_admin_can_publish('gallery'::character varying))
  with check (my_tenant_id() = tenant_id and current_admin_can_publish('gallery'::character varying));

alter policy public_read_albums on gallery_albums
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy gallery_items_publish on gallery_items
  using (my_tenant_id() = tenant_id and current_admin_can_publish('gallery'::character varying))
  with check (my_tenant_id() = tenant_id and current_admin_can_publish('gallery'::character varying));

alter policy public_read_gallery_items on gallery_items
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy news_comments_delete_own_portal on news_comments
  using (my_tenant_id() = tenant_id and portal_user_id = current_portal_user_id());

alter policy news_comments_delete_own_staff on news_comments
  using (my_tenant_id() = tenant_id and admin_user_id = current_admin_user_id());

alter policy news_comments_insert_portal on news_comments
  with check (my_tenant_id() = tenant_id and (comment_type)::text = 'user'::text and portal_user_id = current_portal_user_id());

alter policy news_comments_insert_staff on news_comments
  with check (my_tenant_id() = tenant_id and (comment_type)::text = 'staff'::text and admin_user_id = current_admin_user_id());

alter policy news_comments_moderate on news_comments
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy news_comments_read on news_comments
  using (tenant_id = coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and (is_hidden = false or portal_user_id = current_portal_user_id() or (exists (select 1 from admin_users where admin_users.auth_user_id = auth.uid() and admin_users.is_active = true))));

alter policy news_posts_donor_read_own on news_posts
  using (my_tenant_id() = tenant_id and submitted_by_portal_user_id = current_portal_user_id());

alter policy news_posts_donor_submit on news_posts
  with check (my_tenant_id() = tenant_id and (category)::text = 'blog'::text and submitted_by_portal_user_id = current_portal_user_id());

alter policy news_posts_publish on news_posts
  using (my_tenant_id() = tenant_id and current_admin_can_publish_category(category))
  with check (my_tenant_id() = tenant_id and current_admin_can_publish_category(category));

alter policy public_read_published_news on news_posts
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_published = true);

alter policy news_ticker_publish on news_ticker
  using (my_tenant_id() = tenant_id and current_admin_can_publish('ticker'::character varying))
  with check (my_tenant_id() = tenant_id and current_admin_can_publish('ticker'::character varying));

alter policy public_read_active_ticker on news_ticker
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_active = true);

alter policy post_categories_read on post_categories
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

alter policy post_categories_write on post_categories
  using (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]))
  with check (my_tenant_id() = tenant_id and (current_admin_role())::text = any ((array['super_admin'::character varying, 'admin'::character varying])::text[]));

alter policy public_read_published_videos on video_content
  using (tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid and is_published = true);

alter policy video_content_publish on video_content
  using (my_tenant_id() = tenant_id and current_admin_can_publish('videos'::character varying))
  with check (my_tenant_id() = tenant_id and current_admin_can_publish('videos'::character varying));
