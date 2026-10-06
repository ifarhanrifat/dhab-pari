-- Phase 2, slice 2 (RLS): same uniform transformation as migrations
-- 568/574 -- prepend `tenant_id = my_tenant_id() AND` to every USING/CHECK,
-- with the genuinely anonymous-readable policies (vehicles/routes/media/
-- service-offers/city-shops/addas/fare-bands/service-classes/villages/
-- cities/classified-listings/weekend-share-offers/wedding-functions/open
-- trip-offers/adda-queue/product-media/purchase-fee-tiers -- all either
-- `qual = true` or `is_active = true` for the `public` role, with no
-- auth.role() = 'authenticated' guard) getting the one real tenant's id
-- hardcoded instead, since there's no auth.uid() for my_tenant_id() to
-- resolve for a logged-out visitor -- see migration 568's header for the
-- full reasoning, identical here.

alter policy "public_read_adda_queue_entries" on adda_queue_entries
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "addas_admin_write" on addas
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "public_read_addas" on addas
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "catalog_brand_submissions_owner_read" on catalog_brand_submissions
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR user_manages_shop(shop_id))));

alter policy "cities_delete" on cities
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "cities_update" on cities
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "cities_write" on cities
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "public_read_cities" on cities
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "city_purchase_invitations_parties_read" on city_purchase_invitations
  using ((tenant_id = my_tenant_id()) AND (is_party_to_city_purchase(request_id)));

alter policy "city_purchase_requests_parties_read" on city_purchase_requests
  using ((tenant_id = my_tenant_id()) AND (is_party_to_city_purchase(id)));

alter policy "city_shops_delete" on city_shops
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "city_shops_update" on city_shops
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "city_shops_write" on city_shops
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "public_read_city_shops" on city_shops
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "classified_listings_public_read" on classified_listings
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active = true)));

alter policy "classified_listings_self_all" on classified_listings
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())))
  with check ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "classified_listings_staff_moderate" on classified_listings
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "classified_listings_staff_read" on classified_listings
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "commuter_schedules_own" on commuter_schedules
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (portal_user_id = current_portal_user_id()))))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (portal_user_id = current_portal_user_id()))));

alter policy "dispatch_calls_parties_read" on dispatch_calls
  using ((tenant_id = my_tenant_id()) AND (is_party_to_dispatch(id)));

alter policy "dispatch_invitations_parties_read" on dispatch_invitations
  using ((tenant_id = my_tenant_id()) AND (is_party_to_dispatch(call_id)));

alter policy "disputes_admin_read" on disputes
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (filed_by_portal_user_id = current_portal_user_id()))));

alter policy "fare_bands_update" on fare_bands
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "fare_bands_write" on fare_bands
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "public_read_fare_bands" on fare_bands
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "hourly_booking_locations_parties_read" on hourly_booking_locations
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM hourly_bookings b
  WHERE ((b.id = hourly_booking_locations.booking_id) AND ((b.portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
           FROM vehicles v
          WHERE ((v.id = b.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))))))));

alter policy "hourly_bookings_parties_read" on hourly_bookings
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = hourly_bookings.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "negotiation_messages_parties_read" on negotiation_messages
  using ((tenant_id = my_tenant_id()) AND (is_party_to_negotiation(thread_id)));

alter policy "negotiation_threads_parties_read" on negotiation_threads
  using ((tenant_id = my_tenant_id()) AND (is_party_to_negotiation(id)));

alter policy "product_media_delete" on product_media
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = product_media.product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "product_media_update" on product_media
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = product_media.product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "product_media_write" on product_media
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM shop_products p
  WHERE ((p.id = product_media.product_id) AND user_manages_shop(p.shop_id)))))));

alter policy "public_read_product_media" on product_media
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "public_read_purchase_fee_tiers" on purchase_fee_tiers
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "purchase_fee_tiers_delete" on purchase_fee_tiers
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "purchase_fee_tiers_update" on purchase_fee_tiers
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "purchase_fee_tiers_write" on purchase_fee_tiers
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "purchase_line_items_read" on purchase_line_items
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM purchases p
  WHERE ((p.id = purchase_line_items.purchase_id) AND can_access_system(p.system))))));

alter policy "purchase_line_items_write" on purchase_line_items
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM purchases p
  WHERE ((p.id = purchase_line_items.purchase_id) AND can_access_system(p.system) AND current_admin_permission('post_transactions'::character varying))))));

alter policy "purchases_delete" on purchases
  using ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "purchases_read" on purchases
  using ((tenant_id = my_tenant_id()) AND (can_access_system(system)));

alter policy "purchases_write" on purchases
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system(system) AND current_admin_permission('post_transactions'::character varying))));

alter policy "ride_bookings_admin_read" on ride_bookings
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "ride_bookings_keeper_read" on ride_bookings
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (vehicle_routes r
     JOIN vehicles v ON ((v.id = r.vehicle_id)))
  WHERE ((r.id = ride_bookings.route_id) AND (v.portal_user_id = current_portal_user_id()))))));

alter policy "ride_bookings_portal_read_own" on ride_bookings
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "public_read_service_classes" on service_classes
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "service_classes_delete" on service_classes
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "service_classes_update" on service_classes
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "service_classes_write" on service_classes
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "shadi_events_parties_read" on shadi_events
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (portal_user_id = current_portal_user_id()) OR (EXISTS ( SELECT 1
   FROM (shadi_vehicle_requests r
     JOIN vehicles v ON ((v.id = r.vehicle_id)))
  WHERE ((r.event_id = shadi_events.id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "shadi_vehicle_requests_parties_read" on shadi_vehicle_requests
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = shadi_vehicle_requests.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))) OR (EXISTS ( SELECT 1
   FROM shadi_events e
  WHERE ((e.id = shadi_vehicle_requests.event_id) AND (e.portal_user_id = current_portal_user_id())))))));

alter policy "public_read_vehicle_city_presence" on vehicle_city_presence
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "vehicle_city_presence_write" on vehicle_city_presence
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_city_presence.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_city_presence.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "vehicle_lumpsum_charges_admin_read" on vehicle_lumpsum_charges
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "vehicle_lumpsum_charges_keeper_read" on vehicle_lumpsum_charges
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_lumpsum_charges.vehicle_id) AND (v.portal_user_id = current_portal_user_id()))))));

alter policy "public_read_vehicle_media" on vehicle_media
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "vehicle_media_delete" on vehicle_media
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_media.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "vehicle_media_update" on vehicle_media
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_media.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "vehicle_media_write" on vehicle_media
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_media.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "vehicle_registration_requests_own_read" on vehicle_registration_requests
  using ((tenant_id = my_tenant_id()) AND (((portal_user_id = current_portal_user_id()) OR current_admin_permission('manage_parties'::character varying))));

alter policy "public_read_vehicle_routes" on vehicle_routes
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "vehicle_routes_delete" on vehicle_routes
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "vehicle_routes_update" on vehicle_routes
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "vehicle_routes_write" on vehicle_routes
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "public_read_vehicle_service_offers" on vehicle_service_offers
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "vehicle_service_offers_admin_delete" on vehicle_service_offers
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "vehicle_service_offers_admin_update" on vehicle_service_offers
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "vehicle_service_offers_admin_write" on vehicle_service_offers
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "trip_bookings_admin_read" on vehicle_trip_bookings
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "trip_bookings_driver_read" on vehicle_trip_bookings
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_trip_bookings.vehicle_id) AND (v.portal_user_id = current_portal_user_id()))))));

alter policy "trip_bookings_rider_read" on vehicle_trip_bookings
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "trip_fare_offers_driver_read" on vehicle_trip_fare_offers
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (vehicle_trip_offers o
     JOIN vehicles v ON ((v.id = o.vehicle_id)))
  WHERE ((o.id = vehicle_trip_fare_offers.trip_offer_id) AND (v.portal_user_id = current_portal_user_id()))))));

alter policy "trip_fare_offers_rider_read" on vehicle_trip_fare_offers
  using ((tenant_id = my_tenant_id()) AND ((portal_user_id = current_portal_user_id())));

alter policy "trip_locations_matched_parties_read" on vehicle_trip_locations
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM (vehicle_trip_bookings b
     JOIN vehicles v ON ((v.id = b.vehicle_id)))
  WHERE ((b.id = vehicle_trip_locations.trip_booking_id) AND ((b.portal_user_id = current_portal_user_id()) OR (v.portal_user_id = current_portal_user_id())))))));

alter policy "trip_offer_locations_signed_in_read" on vehicle_trip_offer_locations
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vehicle_trip_offers o
  WHERE ((o.id = vehicle_trip_offer_locations.trip_offer_id) AND o.share_live_location AND (o.travel_date >= ((now() AT TIME ZONE 'Asia/Karachi'::text))::date))))));

alter policy "public_read_open_trip_offers" on vehicle_trip_offers
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((((status)::text = 'open'::text) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_trip_offers.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "vehicle_type_commission_rates_admin_all" on vehicle_type_commission_rates
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "vehicle_wallet_topups_admin_read" on vehicle_wallet_topups
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)));

alter policy "vehicle_wallet_topups_keeper_read" on vehicle_wallet_topups
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = vehicle_wallet_topups.vehicle_id) AND (v.portal_user_id = current_portal_user_id()))))));

alter policy "public_read_vehicles" on vehicles
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "vehicles_delete" on vehicles
  using ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('delete_transactions'::character varying))));

alter policy "vehicles_update" on vehicles
  using ((tenant_id = my_tenant_id()) AND (can_access_system('donors_projects'::character varying)))
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "vehicles_write" on vehicles
  with check ((tenant_id = my_tenant_id()) AND ((can_access_system('donors_projects'::character varying) AND current_admin_permission('manage_parties'::character varying))));

alter policy "public_read_villages" on villages
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((is_active OR current_admin_permission('manage_parties'::character varying))));

alter policy "villages_delete" on villages
  using ((tenant_id = my_tenant_id()) AND (current_admin_permission('delete_transactions'::character varying)));

alter policy "villages_update" on villages
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "villages_write" on villages
  with check ((tenant_id = my_tenant_id()) AND (current_admin_permission('manage_parties'::character varying)));

alter policy "wedding_functions_public_read" on wedding_functions
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND ((EXISTS ( SELECT 1
   FROM village_events
  WHERE ((village_events.id = wedding_functions.event_id) AND (village_events.is_active = true))))));

alter policy "wedding_functions_staff_all" on wedding_functions
  using ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))))
  with check ((tenant_id = my_tenant_id()) AND ((EXISTS ( SELECT 1
   FROM admin_users
  WHERE ((admin_users.auth_user_id = auth.uid()) AND (admin_users.is_active = true))))));

alter policy "public_read_weekend_share_offers" on weekend_share_offers
  using ((tenant_id = 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) AND (true));

alter policy "weekend_share_offers_delete" on weekend_share_offers
  using ((tenant_id = my_tenant_id()) AND ((current_admin_permission('delete_transactions'::character varying) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = weekend_share_offers.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))))));

alter policy "weekend_share_offers_insert" on weekend_share_offers
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = weekend_share_offers.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))) AND ((EXISTS ( SELECT 1
   FROM cities c
  WHERE ((c.id = weekend_share_offers.city_id) AND c.is_home_city))) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = weekend_share_offers.vehicle_id) AND v.allows_out_of_city))))))));

alter policy "weekend_share_offers_update" on weekend_share_offers
  using ((tenant_id = my_tenant_id()) AND (true))
  with check ((tenant_id = my_tenant_id()) AND ((current_admin_permission('manage_parties'::character varying) OR ((EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = weekend_share_offers.vehicle_id) AND (v.portal_user_id = current_portal_user_id())))) AND ((EXISTS ( SELECT 1
   FROM cities c
  WHERE ((c.id = weekend_share_offers.city_id) AND c.is_home_city))) OR (EXISTS ( SELECT 1
   FROM vehicles v
  WHERE ((v.id = weekend_share_offers.vehicle_id) AND v.allows_out_of_city))))))));

-- 93 policies total
