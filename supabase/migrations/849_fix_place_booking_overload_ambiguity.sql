-- Migration 849: critical bug found live while verifying 848 — 846
-- added p_seat_numbers/p_seat_number to place_ride_booking and
-- book_standalone_return_seat via CREATE OR REPLACE, but
-- CREATE OR REPLACE cannot change a function's signature. The old,
-- shorter-signature versions were never dropped, so Postgres has had
-- TWO overloads of each live since 846 shipped. Any caller that omits
-- the optional trailing param entirely (fewer JSON keys than either
-- signature requires extra of) gets PGRST203 "could not choose the
-- best candidate function" instead of a booking — confirmed via a
-- live read-only curl check against production just now.
--
-- Real, currently-reachable casualty found: travel/page.tsx's
-- bookRideHome() ("book a ride home") calls book_standalone_return_
-- seat with only 3 of its params — this has been silently broken for
-- every rider since 846 shipped, not something this session's changes
-- caused. Every other call site in the app happens to always pass
-- every optional key explicitly (even as null), so this is the only
-- currently-broken caller, but the ambiguity itself was live for any
-- future/other caller too.
--
-- Fix: drop the stale old-signature overloads. The remaining (846/
-- 847/848) signature already defaults every added param to NULL, so
-- every existing short call (including travel/page.tsx's) keeps
-- working unchanged — no frontend edit needed.

DROP FUNCTION IF EXISTS place_ride_booking(uuid, date, int, varchar, text, uuid, uuid);
DROP FUNCTION IF EXISTS book_standalone_return_seat(uuid, date, uuid, varchar, text);
