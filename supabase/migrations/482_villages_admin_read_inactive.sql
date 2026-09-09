-- Real bug caught while building the new marketplace-reference admin
-- page (villages/cities/service_classes CRUD, a confirmed gap found
-- auditing the vehicle-system mockups): villages' own read policy
-- (471) is `USING (is_active)` — unlike cities and service_classes,
-- which are both `USING (true)`. An admin deactivating a village would
-- make it vanish from their own list, with no way back to reactivate
-- it through the UI (the toggle button that would flip it back on
-- can't render for a row RLS won't even return).
DROP POLICY IF EXISTS "public_read_villages" ON villages;
CREATE POLICY "public_read_villages" ON villages FOR SELECT
  USING (is_active OR current_admin_permission('manage_parties'));
