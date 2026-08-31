-- Migration 403: vehicle_trip_offers.seats_available had CHECK (> 0),
-- which correctly stops a driver posting a trip with zero seats, but
-- also blocks the legitimate case of decrementing down TO zero once the
-- last seat is booked — caught live, a fully-booked trip's own closing
-- UPDATE failed outright with a constraint violation. The "at least 1 on
-- creation" rule already lives in place_trip_offer()'s own validation;
-- the column itself just needs to allow 0 once seats run out.
ALTER TABLE vehicle_trip_offers DROP CONSTRAINT IF EXISTS vehicle_trip_offers_seats_available_check;
ALTER TABLE vehicle_trip_offers ADD CONSTRAINT vehicle_trip_offers_seats_available_check CHECK (seats_available >= 0);
