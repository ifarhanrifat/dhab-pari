-- CRITICAL SECURITY FIX: 52 "public browsing" RLS policies across the
-- entire schema were created with no `TO anon` role restriction. A
-- Postgres policy with no TO clause applies to role PUBLIC, which
-- includes `authenticated` as well as `anon` -- so every one of these
-- policies, written to let an anonymous visitor read dhab-pari's own
-- public content (hardcoded as `tenant_id = '<dhab-pari-uuid>'`), ALSO
-- silently granted that same hardcoded access to any authenticated user
-- of ANY tenant. RLS combines multiple permissive policies with OR, so
-- even though the correct tenant-scoped authenticated policy exists
-- alongside it on most of these tables, this leftover policy still let
-- it through regardless.
--
-- Found live, 2026-10-07: a freshly created second tenant's own
-- super_admin could see dhab-pari's shops, vehicles, news ticker, news
-- posts, site_settings (including committee contact/address/logo),
-- important_contacts, directory_entries, and more -- confirmed directly
-- against the database, not a UI/caching artifact.
--
-- Fix, part 1: for every one of these 52 policies where a SEPARATE,
-- already-correct `tenant_id = my_tenant_id()` policy exists on the same
-- table for `authenticated`, simply restrict the leftover public policy
-- `TO anon`. This changes nothing about anonymous-visitor behaviour --
-- same USING clause, same rows -- it only removes `authenticated` from
-- matching it, so an authenticated user falls back to the table's own
-- correctly tenant-scoped policy exactly as every other table in this
-- schema already works.
alter policy public_read_account_headers on account_headers to anon;
alter policy public_read_addas on addas to anon;
alter policy ag_disease_guides_public_read on ag_disease_guides to anon;
alter policy ag_help_centers_public_read on ag_help_centers to anon;
alter policy ag_livestock_guides_public_read on ag_livestock_guides to anon;
alter policy ag_schemes_public_read on ag_schemes to anon;
alter policy civic_reports_public_read on civic_reports to anon;
alter policy classified_listings_public_read on classified_listings to anon;
alter policy public_read_active_members on committee_members to anon;
alter policy committee_notes_public_read on committee_notes to anon;
alter policy crop_prices_public_read on crop_prices to anon;
alter policy death_announcements_public_read on death_announcements to anon;
alter policy public_read_active_directory_entries on directory_entries to anon;
alter policy public_read_albums on gallery_albums to anon;
alter policy public_read_gallery_items on gallery_items to anon;
alter policy help_requests_public_read on help_requests to anon;
alter policy public_read_active_contacts on important_contacts to anon;
alter policy institutes_read on institutes to anon;
alter policy job_listings_public_read on job_listings to anon;
alter policy lost_found_public_read on lost_found_posts to anon;
alter policy public_read_published_news on news_posts to anon;
alter policy public_read_active_ticker on news_ticker to anon;
alter policy post_categories_read on post_categories to anon;
alter policy public_read_project_media on project_media to anon;
alter policy sadqa_catalogue_read on sadqa_catalogue to anon;
alter policy public_read_settings on site_settings to anon;
alter policy support_pools_read on support_pools to anon;
alter policy talent_showcases_public_read on talent_showcases to anon;
alter policy training_batches_read on training_batches to anon;
alter policy public_read_transactions on transactions to anon;
alter policy public_read_vehicle_city_presence on vehicle_city_presence to anon;
alter policy public_read_published_videos on video_content to anon;
alter policy village_events_public_read on village_events to anon;
alter policy village_landmarks_public_read on village_landmarks to anon;
alter policy wedding_functions_public_read on wedding_functions to anon;

-- Fix, part 2: these 17 tables had NO separate authenticated SELECT
-- policy at all -- the leftover public one was the ONLY thing granting
-- authenticated read access, including for dhab-pari's own admins today
-- (it "worked" only because dhab-pari's own tenant_id happens to be the
-- hardcoded literal). Restricting it to anon alone, with nothing else
-- added, would have taken away dhab-pari's own admin/portal read access
-- to these tables. So each gets BOTH: the same restriction to anon, AND
-- a new, genuinely tenant-scoped authenticated SELECT policy carrying the
-- exact same business logic the old one had (open/active/own-row checks),
-- just keyed to my_tenant_id() instead of a hardcoded tenant.
alter policy public_read_adda_queue_entries on adda_queue_entries to anon;
create policy adda_queue_entries_authenticated_read on adda_queue_entries
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_cities on cities to anon;
create policy cities_authenticated_read on cities
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_city_shops on city_shops to anon;
create policy city_shops_authenticated_read on city_shops
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_fare_bands on fare_bands to anon;
create policy fare_bands_authenticated_read on fare_bands
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_product_media on product_media to anon;
create policy product_media_authenticated_read on product_media
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_purchase_fee_tiers on purchase_fee_tiers to anon;
create policy purchase_fee_tiers_authenticated_read on purchase_fee_tiers
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_sectors on sectors to anon;
create policy sectors_authenticated_read on sectors
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_service_classes on service_classes to anon;
create policy service_classes_authenticated_read on service_classes
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_shop_products on shop_products to anon;
create policy shop_products_authenticated_read on shop_products
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_shops on shops to anon;
create policy shops_authenticated_read on shops
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_vehicle_media on vehicle_media to anon;
create policy vehicle_media_authenticated_read on vehicle_media
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_vehicle_routes on vehicle_routes to anon;
create policy vehicle_routes_authenticated_read on vehicle_routes
  for select to authenticated using (tenant_id = my_tenant_id());

alter policy public_read_vehicle_service_offers on vehicle_service_offers to anon;
create policy vehicle_service_offers_authenticated_read on vehicle_service_offers
  for select to authenticated using (tenant_id = my_tenant_id());

-- Preserves the original "open offers, or your own vehicle's offers"
-- business logic -- just scoped to the caller's own tenant instead of
-- dhab-pari's hardcoded one.
alter policy public_read_open_trip_offers on vehicle_trip_offers to anon;
create policy vehicle_trip_offers_authenticated_read on vehicle_trip_offers
  for select to authenticated using (
    tenant_id = my_tenant_id()
    and (
      status::text = 'open'::text
      or exists (select 1 from vehicles v where v.id = vehicle_trip_offers.vehicle_id and v.portal_user_id = current_portal_user_id())
    )
  );

alter policy public_read_vehicles on vehicles to anon;
create policy vehicles_authenticated_read on vehicles
  for select to authenticated using (tenant_id = my_tenant_id());

-- Preserves the original "active, or staff with manage_parties" logic.
alter policy public_read_villages on villages to anon;
create policy villages_authenticated_read on villages
  for select to authenticated using (
    tenant_id = my_tenant_id() and (is_active or current_admin_permission('manage_parties'::character varying))
  );

alter policy public_read_weekend_share_offers on weekend_share_offers to anon;
create policy weekend_share_offers_authenticated_read on weekend_share_offers
  for select to authenticated using (tenant_id = my_tenant_id());
