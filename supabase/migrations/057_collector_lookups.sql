-- Migration 057: Two narrow, read-only lookups needed by the field collector
-- pages.
--
-- admin_users' own RLS ("read_admin_users") only lets super_admin/admin read
-- every row — anyone else can only read their own. That's the right default for
-- the full admin_users table (permissions, emails, invite state), but it means a
-- water_accountant (a very plausible "water supply accountant" role) couldn't
-- even see collector names to label their holdings on /admin/collectors, and a
-- collector couldn't see who to notify. Rather than loosen the real table's RLS,
-- expose just the handful of columns actually needed via two SECURITY DEFINER
-- functions.

CREATE OR REPLACE FUNCTION get_field_collectors() RETURNS TABLE (
  id uuid, full_name varchar, mobile varchar, assigned_sectors text[]
) AS $$
  SELECT id, full_name, mobile, assigned_sectors FROM admin_users
  WHERE can_collect_payments = true AND is_active = true AND can_access_system('water_supply');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Same recipient set as trg_payment_collector_notify() — used by the collector's
-- screen to offer a "Notify via WhatsApp" deep-link right after a collection,
-- since there's no WhatsApp Business API to send this automatically.
CREATE OR REPLACE FUNCTION get_water_supply_notify_targets() RETURNS TABLE (
  id uuid, full_name varchar, mobile varchar
) AS $$
  SELECT id, full_name, mobile FROM admin_users
  WHERE is_active = true AND can_access_system('water_supply') AND (
    role IN ('super_admin', 'admin', 'water_accountant')
    OR (role = 'accountant' AND access_water_supply)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
