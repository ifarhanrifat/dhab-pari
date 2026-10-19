-- Migration 704: found while building the parcel-delivery detail page —
-- RateAndReport (reused as-is from City Purchase's own detail page)
-- calls submit_rating(p_ref_type, ...), whose ratings_ref_type_check
-- constraint (653) didn't know about 'parcel_delivery' yet.
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_ref_type_check;
ALTER TABLE ratings ADD CONSTRAINT ratings_ref_type_check CHECK (ref_type IN (
  'dispatch_call', 'city_purchase_request', 'shop_order', 'ride_booking', 'trip_booking',
  'hourly_booking', 'shadi_vehicle_request', 'equipment_booking', 'rental_booking', 'parcel_delivery'
));
