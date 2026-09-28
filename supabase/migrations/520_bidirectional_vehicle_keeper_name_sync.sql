-- Migration 520: keep a vehicle's owner_name and its linked keeper's
-- portal_users.full_name in sync from EITHER side, automatically.
--
-- Real report, 2026-09-29: migration 519 only synced one direction --
-- vehicle owner_name -> portal full_name, and only when explicitly called
-- from the admin Vehicles page's own save/link flow. The admin then edited
-- the driver's name from the OTHER side (Portal Accounts, editing
-- full_name directly) and the marketplace vehicle-route page kept showing
-- the old name, because that page reads vehicles.owner_name, which
-- nothing had touched. Two triggers, one on each table, replace the
-- explicit RPC calls entirely -- whichever side an admin edits, the other
-- follows automatically, regardless of which screen or future code path
-- does the writing.
--
-- IS DISTINCT FROM guards on both sides are what stop this being a
-- write-write loop: table A's trigger updates table B only when B's value
-- actually differs, so the second hop (B's own trigger reacting to that
-- write) finds A already equal and does nothing -- the chain always
-- terminates after one hop in each direction.

CREATE OR REPLACE FUNCTION trg_vehicle_owner_name_to_keeper() RETURNS trigger AS $$
BEGIN
  IF NEW.portal_user_id IS NOT NULL AND NEW.owner_name IS NOT NULL AND trim(NEW.owner_name) <> '' THEN
    UPDATE portal_users SET full_name = NEW.owner_name
     WHERE id = NEW.portal_user_id AND full_name IS DISTINCT FROM NEW.owner_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS vehicle_owner_name_to_keeper_trigger ON vehicles;
CREATE TRIGGER vehicle_owner_name_to_keeper_trigger
AFTER INSERT OR UPDATE OF owner_name, portal_user_id ON vehicles
FOR EACH ROW EXECUTE FUNCTION trg_vehicle_owner_name_to_keeper();

CREATE OR REPLACE FUNCTION trg_keeper_full_name_to_vehicle() RETURNS trigger AS $$
BEGIN
  IF NEW.full_name IS NOT NULL AND trim(NEW.full_name) <> '' THEN
    UPDATE vehicles SET owner_name = NEW.full_name
     WHERE portal_user_id = NEW.id AND owner_name IS DISTINCT FROM NEW.full_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS keeper_full_name_to_vehicle_trigger ON portal_users;
CREATE TRIGGER keeper_full_name_to_vehicle_trigger
AFTER UPDATE OF full_name ON portal_users
FOR EACH ROW EXECUTE FUNCTION trg_keeper_full_name_to_vehicle();

-- Fixes the live report directly: the vehicle currently linked to
-- Kaka_Hadi's account picks up whatever full_name that account holds
-- right now ("Rizwan Iqbal"), the same way it would have if this trigger
-- had already existed when the admin made that edit.
UPDATE vehicles v SET owner_name = pu.full_name
  FROM portal_users pu
 WHERE v.portal_user_id = pu.id
   AND pu.full_name IS NOT NULL AND trim(pu.full_name) <> ''
   AND v.owner_name IS DISTINCT FROM pu.full_name;
