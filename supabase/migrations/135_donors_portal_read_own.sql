-- Migration 135: A portal user could INSERT their own pledge
-- (donors_portal_pledge_insert, migration 133) but had no way to read it
-- back — donors_read (migration 014) is staff-only. Without this, there's
-- no way to build a "Pay Now" action on a donor's own pledge; caught while
-- building the portal UI for exactly that.
CREATE POLICY "donors_portal_read_own" ON donors FOR SELECT TO authenticated
  USING (portal_user_id = current_portal_user_id());
