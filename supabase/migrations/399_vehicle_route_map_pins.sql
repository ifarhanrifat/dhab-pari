-- Migration 399: static origin/destination pins for a route's map — staff
-- sets them once (by clicking a free OpenStreetMap/Leaflet map in the
-- admin route form, no geocoding service involved), the customer route
-- page then just shows two markers. Nullable throughout: a route with no
-- pins set still works exactly as before, just without the map.
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS origin_lat decimal;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS origin_lng decimal;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS destination_lat decimal;
ALTER TABLE vehicle_routes ADD COLUMN IF NOT EXISTS destination_lng decimal;
