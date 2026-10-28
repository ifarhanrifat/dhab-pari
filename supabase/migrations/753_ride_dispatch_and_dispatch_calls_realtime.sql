-- Migration 753: same real gap 726 already found and fixed for
-- hourly/rental/equipment/ride_bookings -- a postgres_changes channel
-- on a table that was never added to the supabase_realtime publication
-- silently never fires, so results/page.tsx's and the standalone
-- ride-dispatch/dispatch-call detail pages' new Realtime subscriptions
-- (useRealtimeRefresh) would otherwise run on poll-fallback alone,
-- same as every one of those four tables did before 726. RLS still
-- governs who actually receives a row's changes -- this only lets a
-- change through the wire at all.
ALTER PUBLICATION supabase_realtime ADD TABLE ride_dispatch_requests;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_calls;
