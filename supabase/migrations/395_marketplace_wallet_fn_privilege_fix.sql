-- Migration 395: 394 left two internal helper functions without an
-- explicit REVOKE — Postgres grants EXECUTE to PUBLIC by default on a new
-- function, and `authenticated` inherits from PUBLIC, so any signed-in
-- user (any portal account) could currently call
-- seller_account_balance(any_account_id) directly via RPC and read the
-- exact balance of ANY account in the whole system, not just a shop/
-- vehicle's own. check_seller_balance_notify() is lower severity (it only
-- ever notifies the real linked owner, never the caller) but has no
-- business being client-callable either. Neither is meant to be called
-- directly — every legitimate caller (confirm_shop_order,
-- confirm_ride_booking, shop_bookable, vehicle_bookable, the wallet
-- top-up functions) already reaches them as an internal call within its
-- own SECURITY DEFINER execution, which needs no grant on the callee.
--
-- Per the standing gotcha in this codebase: REVOKE FROM PUBLIC alone does
-- nothing for `authenticated`/`anon` — they must be named explicitly.
REVOKE ALL ON FUNCTION seller_account_balance(uuid) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION check_seller_balance_notify(varchar, uuid) FROM PUBLIC, authenticated, anon;
