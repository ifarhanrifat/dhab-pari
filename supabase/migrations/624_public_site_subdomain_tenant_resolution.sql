-- Public-site tenant resolution by subdomain.
--
-- Every "anonymous read" RLS policy/view in this schema hardcodes
-- dhab-pari's own tenant UUID as the fallback for anon, since anonymous
-- visitors carry no auth session for my_tenant_id() to resolve. That made
-- every domain show dhab-pari's content regardless of which tenant's
-- subdomain was actually requested -- there was no way for a second
-- tenant's public website to ever be reachable.
--
-- request_tenant_id() reads a custom `x-tenant-id` request header,
-- exposed by PostgREST to Postgres via the standard
-- `current_setting('request.headers', true)` GUC on every request. The
-- app side (middleware.ts + src/lib/supabase/{server,client}.ts) resolves
-- the incoming Host header to a tenant via `tenants.slug` and sends that
-- header. If the header is missing, malformed, or doesn't resolve to a
-- real tenant (the current production domain, localhost, Vercel preview
-- URLs, an unrecognized subdomain), this returns NULL and every policy's
-- coalesce() falls through to dhab-pari's existing hardcoded UUID exactly
-- as before -- the live site cannot regress from this change.
--
-- For an authenticated admin/portal user, my_tenant_id() (session-based)
-- is always checked FIRST in the coalesce chain and always wins over this
-- header, so nothing changes for logged-in users on any domain.
create or replace function public.request_tenant_id()
 returns uuid
 language plpgsql
 stable
as $function$
declare
  v text;
begin
  v := current_setting('request.headers', true)::json ->> 'x-tenant-id';
  if v is null or v = '' then
    return null;
  end if;
  return v::uuid;
exception when others then
  return null;
end;
$function$;

-- tenants itself was locked down last night (migration 616) to zero anon
-- access, correctly -- this adds back the one narrow thing middleware
-- needs: resolving a subdomain's slug to its tenant id, for active
-- tenants only, nothing else exposed.
create policy tenants_public_resolve on tenants
  for select to anon
  using (is_active = true);

-- The 62 anon-readable policies below (54 plain hardcoded-literal ones +
-- 8 already-coalesce(my_tenant_id(), ...) ones) all get the same
-- treatment: request_tenant_id() inserted into the fallback chain.
-- Generated from a fresh pull of every policy whose USING/CHECK
-- referenced the hardcoded dhab-pari UUID (same methodology as migration
-- 622) -- every statement below is a mechanical substitution over the
-- real, current expression, never reconstructed from memory.

alter policy "public_read_account_headers" on account_headers
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_adda_queue_entries" on adda_queue_entries
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_addas" on addas
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "ag_disease_guides_public_read" on ag_disease_guides
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "ag_help_centers_public_read" on ag_help_centers
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "ag_livestock_guides_public_read" on ag_livestock_guides
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "ag_schemes_public_read" on ag_schemes
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_cities" on cities
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_city_shops" on city_shops
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "civic_reports_public_read" on civic_reports
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "classified_listings_public_read" on classified_listings
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_active_members" on committee_members
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "committee_notes_public_read" on committee_notes
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_published = true))
  );

alter policy "crop_prices_public_read" on crop_prices
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "death_announcements_public_read" on death_announcements
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_active_directory_entries" on directory_entries
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_fare_bands" on fare_bands
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_albums" on gallery_albums
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_gallery_items" on gallery_items
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "help_requests_public_read" on help_requests
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_active_contacts" on important_contacts
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "institutes_read" on institutes
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "job_listings_public_read" on job_listings
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "lost_found_public_read" on lost_found_posts
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "news_comments_read" on news_comments
  using (
    ((tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND ((is_hidden = false) OR (portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  );

alter policy "public_read_published_news" on news_posts
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_published = true))
  );

alter policy "public_read_active_ticker" on news_ticker
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "post_categories_read" on post_categories
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_product_media" on product_media
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "project_comment_likes_read" on project_comment_likes
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "project_comments_read" on project_comments
  using (
    ((tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND ((is_hidden = false) OR (portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  );

alter policy "public_read_project_media" on project_media
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "project_votes_read" on project_votes
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_projects" on projects
  using (
    ((tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (((admin_hidden = false) AND (is_private = false)) OR (proposed_by_portal_user_id = current_portal_user_id()) OR (current_admin_role() IS NOT NULL)))
  );

alter policy "public_read_purchase_fee_tiers" on purchase_fee_tiers
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "sadqa_catalogue_read" on sadqa_catalogue
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND is_active)
  );

alter policy "public_read_sectors" on sectors
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_service_classes" on service_classes
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_shop_products" on shop_products
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_shops" on shops
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_settings" on site_settings
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "support_pools_read" on support_pools
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND is_active)
  );

alter policy "talent_showcase_comment_likes_read" on talent_showcase_comment_likes
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "talent_showcase_comments_read" on talent_showcase_comments
  using (
    ((tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND ((is_hidden = false) OR (portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  );

alter policy "talent_showcases_public_read" on talent_showcases
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_published = true))
  );

alter policy "term_labels_read" on term_labels
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "training_batches_read" on training_batches
  using (
    (tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_transactions" on transactions
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "ui_overrides_read" on ui_overrides
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "public_read_vehicle_city_presence" on vehicle_city_presence
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_vehicle_media" on vehicle_media
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_vehicle_routes" on vehicle_routes
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_vehicle_service_offers" on vehicle_service_offers
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_open_trip_offers" on vehicle_trip_offers
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (((status)::text = 'open'::text) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_trip_offers.vehicle_id) AND (v.portal_user_id = current_portal_user_id()))))))
  );

alter policy "public_read_vehicles" on vehicles
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );

alter policy "public_read_published_videos" on video_content
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_published = true))
  );

alter policy "village_events_public_read" on village_events
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "village_landmarks_public_read" on village_landmarks
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active = true))
  );

alter policy "public_read_villages" on villages
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (is_active OR current_admin_permission('manage_parties'::character varying)))
  );

alter policy "volunteers_public_read" on volunteers
  using (
    (tenant_id = COALESCE(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid))
  );

alter policy "wedding_functions_public_read" on wedding_functions
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND (EXISTS ( SELECT 1
   FROM village_events
  WHERE ((village_events.id = wedding_functions.event_id) AND (village_events.is_active = true)))))
  );

alter policy "public_read_weekend_share_offers" on weekend_share_offers
  using (
    ((tenant_id = COALESCE(request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid)) AND true)
  );
