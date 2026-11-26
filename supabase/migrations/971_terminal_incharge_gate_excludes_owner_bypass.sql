-- Migration 971: real gap pointed out directly, live — "driver again
-- able to start route of his own" (demonstrated on QA Fleet Owner
-- Two's Lahore→Multan route). Confirmed by direct query: that account
-- is the fleet's own owning_portal_user_id, with zero fleet_staff row
-- at all — is_terminal_incharge_or_admin (967) let them through purely
-- because they own the fleet, the same blanket "owner always overrides
-- every counter" rule is_my_counter_or_admin (924) established for
-- every OTHER terminal-scoped action in this app (boarding, no-show,
-- counter writes, etc.).
--
-- That blanket owner-bypass is the right default everywhere else, but
-- the user's explicit ask here is stricter and deliberately asymmetric:
-- starting a route must be bound to a real terminal-in-charge, full
-- stop — owning the fleet (which an owner-operator who also drives
-- will always satisfy) must not be a free pass for this one action,
-- or the whole point of the control is defeated. is_terminal_incharge_
-- or_admin is used nowhere else in the schema (confirmed by grep — only
-- inside start_route_run), so it's true-replaced directly rather than
-- adding a second, parallel helper function.
--
-- Rule 3 ("no real terminal exists") is unaffected — p_counter_id IS
-- NULL still short-circuits true before either EXISTS check runs.
CREATE OR REPLACE FUNCTION is_terminal_incharge_or_admin(p_counter_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_counter_id IS NULL
    OR EXISTS (
      SELECT 1 FROM fleet_counters fc JOIN fleet_staff fs ON fs.fleet_id = fc.fleet_id
      WHERE fc.id = p_counter_id AND fs.portal_user_id = current_portal_user_id()
        AND fs.role NOT IN ('driver', 'accountant')
        AND (fs.counter_id IS NULL OR fs.counter_id = p_counter_id)
    );
$$;
REVOKE ALL ON FUNCTION is_terminal_incharge_or_admin(uuid) FROM PUBLIC, anon;
