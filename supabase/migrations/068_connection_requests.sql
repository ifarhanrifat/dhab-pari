-- Migration 068: New Connection Request workflow — a challan/request that can
-- exist before any money moves (status 'pending_payment'), only becoming a
-- real financial transaction at Cash Receive time (status 'processing', with
-- a bill + payment auto-generated from the request's items/charges), and
-- finally 'installed' once activated with a recurring schedule. Replaces the
-- previous ad-hoc approach of billing a new connection as a free-text "Other
-- Charge" line with no dedicated request/challan step of its own.

INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-2004', 'Plumber Charge Income', 'income', 'water_supply', 'Charged to consumers for plumbing work during a new connection installation', true),
  ('WS-2005', 'Digging Charge Income', 'income', 'water_supply', 'Charged to consumers for digging/excavation work during a new connection installation', true)
ON CONFLICT (code, system) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS connection_request_no_seq START 1;
CREATE OR REPLACE FUNCTION next_connection_request_no() RETURNS varchar AS $$
  SELECT 'NCR-' || lpad(nextval('connection_request_no_seq')::text, 5, '0');
$$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number varchar UNIQUE,
  status varchar NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('draft', 'pending_payment', 'processing', 'installed')),
  consumer_name varchar NOT NULL,
  consumer_phone varchar NOT NULL,
  consumer_address text,
  sector varchar,
  requested_date date NOT NULL DEFAULT current_date,
  description text,
  wants_inventory_from_us boolean NOT NULL DEFAULT false,
  plumber_charge decimal NOT NULL DEFAULT 0 CHECK (plumber_charge >= 0),
  digging_charge decimal NOT NULL DEFAULT 0 CHECK (digging_charge >= 0),
  security_deposit_amount decimal NOT NULL DEFAULT 0 CHECK (security_deposit_amount >= 0),
  total_amount decimal NOT NULL DEFAULT 0,
  -- Set at Cash Receive:
  bill_id uuid REFERENCES bills(id),
  payment_id uuid REFERENCES payments(id),
  consumer_id varchar REFERENCES consumers(consumer_id),
  -- Set at Activation:
  recurring_schedule_id uuid REFERENCES recurring_schedules(id),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION trg_connection_request_assign_number() RETURNS trigger AS $$
BEGIN
  IF NEW.request_number IS NULL THEN
    NEW.request_number := next_connection_request_no();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS connection_request_assign_number_trigger ON connection_requests;
CREATE TRIGGER connection_request_assign_number_trigger BEFORE INSERT ON connection_requests
  FOR EACH ROW EXECUTE FUNCTION trg_connection_request_assign_number();

CREATE TABLE IF NOT EXISTS connection_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES connection_requests(id) ON DELETE CASCADE,
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity decimal NOT NULL CHECK (quantity > 0),
  unit_price decimal NOT NULL DEFAULT 0 CHECK (unit_price >= 0)
);

-- RLS mirrors the bills table's own policies exactly (same permission names,
-- same can_access_system('water_supply') scoping — this is a water_supply-only
-- feature, matching how bills themselves have no donors_projects equivalent).
ALTER TABLE connection_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "connection_requests_read" ON connection_requests FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "connection_requests_insert" ON connection_requests FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('post_transactions'));
CREATE POLICY "connection_requests_update" ON connection_requests FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('edit_transactions'));
CREATE POLICY "connection_requests_delete" ON connection_requests FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('delete_transactions'));

ALTER TABLE connection_request_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "connection_request_items_read" ON connection_request_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM connection_requests r WHERE r.id = request_id AND can_access_system('water_supply')));
CREATE POLICY "connection_request_items_insert" ON connection_request_items FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM connection_requests r WHERE r.id = request_id AND can_access_system('water_supply') AND current_admin_permission('post_transactions')));
CREATE POLICY "connection_request_items_delete" ON connection_request_items FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM connection_requests r WHERE r.id = request_id AND can_access_system('water_supply') AND current_admin_permission('edit_transactions')));
