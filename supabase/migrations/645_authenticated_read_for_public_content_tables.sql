-- Real bug found live on device, 2026-10-13: "why aren't the news belt
-- running in the portal?" Traced to migration 622 ("critical fix: public
-- policies leak to authenticated") — it correctly closed a real leak by
-- scoping 16 anonymous-read policies to `anon` only, but that also
-- silently removed the ONLY read path those 16 tables had for an
-- ordinary logged-in portal user (not staff, who read everything via
-- their own admin_all_*/current_admin_* policies). An anonymous visitor
-- to the public site could see the news ticker, gallery, job board,
-- institutes, lost & found, sadqa catalogue, support pools, and so on;
-- the moment that same person logged into their own portal account, all
-- of it silently went blank, with no error (RLS just returns zero rows).
--
-- Fixed the same way 637/640 fixed the equivalent gap for functions and
-- views: one parallel `TO authenticated` policy per table, same
-- visibility condition the anon policy already uses, tenant resolution
-- preferring the authenticated session's own my_tenant_id() over the
-- subdomain-cookie request_tenant_id() (meaningful once a second tenant
-- exists; today there's only the one, so this is a no-op for current
-- data either way). Never widens anything an anonymous visitor couldn't
-- already see — it only extends the same visibility to a logged-in
-- portal user, who could see less than an anonymous one before this.
create policy "authenticated_read_active_ticker" on news_ticker for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_published_news" on news_posts for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_published = true);

create policy "authenticated_read_albums" on gallery_albums for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "authenticated_read_gallery_items" on gallery_items for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "authenticated_read_help_requests" on help_requests for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_active_contacts" on important_contacts for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_institutes" on institutes for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_job_listings" on job_listings for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_lost_found" on lost_found_posts for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active = true);

create policy "authenticated_read_post_categories" on post_categories for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "authenticated_read_project_media" on project_media for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "authenticated_read_sadqa_catalogue" on sadqa_catalogue for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active);

create policy "authenticated_read_settings" on site_settings for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "authenticated_read_support_pools" on support_pools for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_active);

-- talent_showcases already has talent_showcases_own_read (authenticated,
-- their own rows only, any moderation status) -- this adds the other
-- published public-at-large showcases authenticated couldn't see before.
create policy "authenticated_read_published_talent" on talent_showcases for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) and is_published = true);

create policy "authenticated_read_training_batches" on training_batches for select to authenticated
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));
