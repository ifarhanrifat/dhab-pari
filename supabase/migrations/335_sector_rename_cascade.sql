-- Migration 335: renaming a sector never touched the 9 tables that store
-- it as a plain varchar matching the sector's *name*, not its id
-- (consumers, portal_users, projects, complaints, connection_requests,
-- blood_donors, job_listings, needs_register, consumer_nonpayment_flags —
-- confirmed against the live schema, not just migration file greps). A
-- rename in Settings silently orphaned every existing record still
-- carrying the old string. A proper foreign key everywhere would be the
-- ideal fix but is a much larger migration across 9 tables' worth of read/
-- write code; renaming honestly enough to not lose data is the immediate
-- problem, so this RPC does the rename and the cascade in one transaction
-- instead.
CREATE OR REPLACE FUNCTION rename_sector(p_id uuid, p_new_name varchar) RETURNS void AS $$
DECLARE
  v_old_name varchar;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized to rename a sector';
  END IF;

  SELECT name INTO v_old_name FROM sectors WHERE id = p_id;
  IF v_old_name IS NULL THEN
    RAISE EXCEPTION 'Sector not found';
  END IF;
  IF v_old_name = p_new_name THEN
    RETURN;
  END IF;

  UPDATE sectors SET name = p_new_name WHERE id = p_id;

  UPDATE consumers SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE portal_users SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE projects SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE complaints SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE connection_requests SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE blood_donors SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE job_listings SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE needs_register SET sector = p_new_name WHERE sector = v_old_name;
  UPDATE consumer_nonpayment_flags SET sector = p_new_name WHERE sector = v_old_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION rename_sector(uuid, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rename_sector(uuid, varchar) TO authenticated;
