-- Migration 065: Fix a fail-open bug in set_consumer_contact_number()
-- (migration 064), caught by live-testing it with no real session before it
-- ever reached the UI — the same class of bug as migrations 062 and 063,
-- recurring a third time despite being an explicitly documented lesson.
--
-- `IF NOT (current_admin_permission('manage_parties') OR current_admin_can_collect_for_consumer(p_consumer_id)) THEN RAISE`
-- looks safe, but both functions return SQL NULL (not false) when there is no
-- matching admin_users row for the caller's session — which happens not just
-- for an unauthenticated/service-role call, but for a genuinely deactivated
-- account (is_active = false) whose auth JWT is still otherwise valid, since
-- both functions filter `WHERE ... AND is_active = true`. `NULL OR NULL` is
-- NULL, `NOT NULL` is NULL, and plpgsql treats a NULL IF-condition as false —
-- so the exception silently doesn't fire and the update proceeds anyway.
--
-- COALESCE(..., false) forces an indeterminate authorization result to count
-- as "not authorized" instead of quietly passing.
CREATE OR REPLACE FUNCTION set_consumer_contact_number(p_consumer_id varchar, p_mobile varchar) RETURNS void AS $$
BEGIN
  IF NOT (
    COALESCE(current_admin_permission('manage_parties'), false)
    OR COALESCE(current_admin_can_collect_for_consumer(p_consumer_id), false)
  ) THEN
    RAISE EXCEPTION 'Not authorized to update this consumer''s contact number.';
  END IF;
  UPDATE consumers SET
    mobile = p_mobile,
    whatsapp_number = COALESCE(NULLIF(whatsapp_number, ''), p_mobile)
  WHERE consumer_id = p_consumer_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
