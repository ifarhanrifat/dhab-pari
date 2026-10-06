-- Phase 2, slice 2 (schema): tenant-scope the vehicle & marketplace
-- domain -- 43 tables covering vehicles/vehicle trips & dispatch, shaadi/
-- weekend/hourly bookings, the city-purchase marketplace, classifieds,
-- negotiation threads, and the fare/commission reference tables that
-- drive them.
--
-- Standard loop (nullable -> backfill -> NOT NULL -> indexed -> DEFAULT),
-- same mechanical pattern as migrations 566/573, across the 40 tables
-- below that have a plain `id` primary key.
--
-- fare_bands, vehicle_trip_locations and vehicle_trip_offer_locations have
-- no plain `id` column and are handled separately below. Only fare_bands'
-- PK is actually re-keyed (its PK is a bare business-key string -- a route
-- "flow" like 'chakwal_to_lahore' -- which collides the moment a second
-- tenant defines its own fare bands); vehicle_trip_locations and
-- vehicle_trip_offer_locations key off trip_booking_id/trip_offer_id,
-- already FKs to an already-tenant-scoped row, so tenant_id is added for
-- consistency and cheap RLS but their PKs are left as-is.
--
-- purchases_purchase_number_key and
-- vehicle_type_commission_rates_vehicle_type_classification_key are
-- business-key uniqueness constraints re-keyed to include tenant_id, same
-- reasoning as accounts_code_system_key etc in migration 566. Every other
-- unique constraint on these 43 tables is already FK-based against a
-- specific, already-tenant-scoped row (vehicle_id, portal_user_id, call_id,
-- event_id, request_id) and needs no change -- two rows in different
-- tenants can never share those FK values in the first place.

do $$
declare
  t text;
  tables text[] := array[
    'adda_queue_entries','addas','catalog_brand_submissions','cities',
    'city_purchase_invitations','city_purchase_requests','city_shops',
    'classified_listings','commuter_schedules','dispatch_calls',
    'dispatch_invitations','disputes','hourly_booking_locations',
    'hourly_bookings','marketplace_search_log','negotiation_messages',
    'negotiation_threads','product_media','purchase_fee_tiers',
    'purchase_line_items','purchases','ride_bookings','service_classes',
    'shadi_events','shadi_vehicle_requests','vehicle_city_presence',
    'vehicle_lumpsum_charges','vehicle_media','vehicle_registration_requests',
    'vehicle_routes','vehicle_service_offers','vehicle_trip_bookings',
    'vehicle_trip_fare_offers','vehicle_trip_offers',
    'vehicle_type_commission_rates','vehicle_wallet_topups','vehicles',
    'villages','wedding_functions','weekend_share_offers'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I add column tenant_id uuid references tenants(id)', t);
    execute format('update %I set tenant_id = ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid where tenant_id is null', t);
    execute format('alter table %I alter column tenant_id set not null', t);
    execute format('create index %I on %I (tenant_id)', t || '_tenant_id_idx', t);
    execute format('alter table %I alter column tenant_id set default coalesce(my_tenant_id(), ''bf9e4815-4104-472a-ab32-114171b7e34d''::uuid)', t);
  end loop;
end $$;

-- fare_bands: PK re-keyed from (flow) to (tenant_id, flow).
alter table fare_bands add column tenant_id uuid references tenants(id);
update fare_bands set tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid where tenant_id is null;
alter table fare_bands alter column tenant_id set not null;
alter table fare_bands drop constraint fare_bands_pkey;
alter table fare_bands add primary key (tenant_id, flow);
create index fare_bands_tenant_id_idx on fare_bands (tenant_id);
alter table fare_bands alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

-- vehicle_trip_locations: PK (trip_booking_id, role) left as-is -- already
-- naturally tenant-scoped via trip_booking_id's own FK.
alter table vehicle_trip_locations add column tenant_id uuid references tenants(id);
update vehicle_trip_locations set tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid where tenant_id is null;
alter table vehicle_trip_locations alter column tenant_id set not null;
create index vehicle_trip_locations_tenant_id_idx on vehicle_trip_locations (tenant_id);
alter table vehicle_trip_locations alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

-- vehicle_trip_offer_locations: PK (trip_offer_id) left as-is, same reasoning.
alter table vehicle_trip_offer_locations add column tenant_id uuid references tenants(id);
update vehicle_trip_offer_locations set tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid where tenant_id is null;
alter table vehicle_trip_offer_locations alter column tenant_id set not null;
create index vehicle_trip_offer_locations_tenant_id_idx on vehicle_trip_offer_locations (tenant_id);
alter table vehicle_trip_offer_locations alter column tenant_id set default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);

-- Business-key unique constraints re-keyed to include tenant_id.
alter table purchases drop constraint purchases_purchase_number_key;
alter table purchases add constraint purchases_purchase_number_key unique (tenant_id, purchase_number);

alter table vehicle_type_commission_rates drop constraint vehicle_type_commission_rates_vehicle_type_classification_key;
alter table vehicle_type_commission_rates add constraint vehicle_type_commission_rates_vehicle_type_classification_key unique (tenant_id, vehicle_type, classification);
