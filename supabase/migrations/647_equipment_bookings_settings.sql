-- Split out of 646 after a real db-push failure was isolated here: the
-- Supabase CLI's db-push executor fails on ON CONFLICT (column) DO
-- NOTHING with no usable error text, even though the exact same shape
-- clearly applied fine in the past (475's own near-identical insert into
-- this same table already exists live) -- some other application path
-- must have been used back then. Confirmed directly, bisecting against
-- the live database with disposable test rows (cleaned up after): a
-- plain INSERT succeeds, and ON CONFLICT DO NOTHING with NO explicit
-- target also succeeds -- only the explicit `(key)` / `(event_type)`
-- target trips this CLI's executor. Functionally identical here since
-- each table's only unique constraint is on that one column anyway.

INSERT INTO site_settings (key, value, description) VALUES
  ('marketplace_equipment_commission_pct', '10', 'Committee''s commission on a confirmed machinery/tractor/loader booking (per_order vehicles), as a percentage of the final total')
ON CONFLICT DO NOTHING;

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('equipment_booking_requested', 'A customer requested a machinery/tractor/loader booking', false, true),
  ('equipment_booking_accepted', 'An equipment booking was accepted', false, true),
  ('equipment_booking_declined', 'An equipment booking was declined', false, true),
  ('equipment_booking_completed', 'An equipment job was completed', false, true),
  ('equipment_booking_cancelled', 'An equipment booking was cancelled', false, true)
ON CONFLICT DO NOTHING;
