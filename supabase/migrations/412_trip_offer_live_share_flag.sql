-- Migration 412: just the two columns adda_mark_departed (409) already
-- needs — a departing adda vehicle can flip its own trip_offer's
-- share_live_location on, so its live position becomes visible on the
-- public "nearby open trips" map once that map exists. The rest of that
-- feature (the separate vehicle_trip_offer_locations table, its RLS, the
-- ping/toggle RPCs, the actual map UI) is still pending — this migration
-- only unblocks the column reference so the adda feature is self-
-- contained and testable now, not a claim that live sharing works yet.
ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS share_live_location boolean NOT NULL DEFAULT false;
ALTER TABLE vehicle_trip_offers ADD COLUMN IF NOT EXISTS live_location_started_at timestamptz;
