-- Migration 035: Chart-of-accounts support for discounts and refundable security
-- deposits, so both show up transparently in reports instead of being silently
-- netted into a smaller bill amount.
--
-- Previously a bill's discount_amount just reduced bills.amount_pkr directly (net
-- method) — income was recognized already-discounted, so gross billing and the
-- cost of discounts given were invisible in the P&L. This switches to the gross
-- method: the bill posts at its full line-item total, and any discount posts as
-- its own leg (debit "Discount Given" expense, credit the consumer's receivable),
-- so gross income, total discounts given, and net profit are all independently
-- visible — matching how a real income statement/trial balance should read.
--
-- Security deposits (e.g. a refundable advance taken for a new connection) are a
-- liability, not income — the committee holds the money but owes it back later.

INSERT INTO accounts (code, name, type, system, description, is_protected)
VALUES
  ('WS-3008', 'Discount Given', 'expense', 'water_supply', 'Discounts/waivers granted on consumer bills', true),
  ('WS-5002', 'Security Deposits Payable', 'liability', 'water_supply', 'Refundable connection/security deposits held on behalf of consumers', true),
  ('DP-3005', 'Discount Given', 'expense', 'donors_projects', 'Discounts/waivers granted', true),
  ('DP-5003', 'Security Deposits Payable', 'liability', 'donors_projects', 'Refundable deposits held', true)
ON CONFLICT (code, system) DO NOTHING;

-- Bills now post at their full (gross) amount; a separate ledger leg records any
-- discount rather than netting it into amount_pkr.
CREATE OR REPLACE FUNCTION trg_bill_ledger() RETURNS trigger AS $$
DECLARE
  v_account_id uuid;
  v_income_account_id uuid;
  v_discount_account_id uuid;
  v_particular text;
BEGIN
  v_account_id := ensure_consumer_account(NEW.consumer_id);
  v_particular := 'Water Bill #' || NEW.bill_number || ' - ' || to_char(make_date(NEW.year, NEW.month, 1), 'FMMonth YYYY');

  DELETE FROM ledger_entries WHERE reference_type = 'bill' AND reference_id = NEW.id;

  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
  VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), v_particular, NEW.amount_pkr, 0, 'bill', NEW.id, NEW.bill_number);

  SELECT id INTO v_income_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-2001';
  IF v_income_account_id IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
    VALUES (v_income_account_id, make_date(NEW.year, NEW.month, 1), v_particular, 0, NEW.amount_pkr, 'bill', NEW.id, NEW.bill_number);
  END IF;

  IF COALESCE(NEW.discount_amount, 0) > 0 THEN
    SELECT id INTO v_discount_account_id FROM accounts WHERE system = 'water_supply' AND code = 'WS-3008';
    IF v_discount_account_id IS NOT NULL THEN
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_discount_account_id, make_date(NEW.year, NEW.month, 1), 'Discount — Bill #' || NEW.bill_number, NEW.discount_amount, 0, 'bill', NEW.id, NEW.bill_number);
      INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, bill_number)
      VALUES (v_account_id, make_date(NEW.year, NEW.month, 1), 'Discount — Bill #' || NEW.bill_number, 0, NEW.discount_amount, 'bill', NEW.id, NEW.bill_number);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- bill_line_items no longer subtracts the discount when recomputing amount_pkr —
-- the bill posts gross, and trg_bill_ledger (above) posts the discount leg
-- separately, so both figures stay independently visible.
CREATE OR REPLACE FUNCTION trg_bill_line_item_change() RETURNS trigger AS $$
DECLARE
  v_bill_id uuid := COALESCE(NEW.bill_id, OLD.bill_id);
  v_sum decimal;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.item_type = 'inventory' THEN
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, reference_type, reference_id, note)
    SELECT NEW.inventory_item_id, 'usage', -NEW.quantity, unit_cost, 'bill', NEW.bill_id, 'Issued via bill line item'
    FROM inventory_items WHERE id = NEW.inventory_item_id;
  ELSIF TG_OP = 'DELETE' AND OLD.item_type = 'inventory' THEN
    INSERT INTO inventory_transactions (item_id, txn_type, quantity, unit_cost_at_time, reference_type, reference_id, note)
    SELECT OLD.inventory_item_id, 'adjustment', OLD.quantity, unit_cost, 'bill', OLD.bill_id, 'Reversed — bill line item removed'
    FROM inventory_items WHERE id = OLD.inventory_item_id;
  END IF;

  SELECT COALESCE(SUM(line_total), 0) INTO v_sum FROM bill_line_items WHERE bill_id = v_bill_id;
  IF v_sum > 0 THEN
    UPDATE bills SET amount_pkr = v_sum WHERE id = v_bill_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Existing bills whose amount_pkr already had the discount netted in: gross them
-- back up so the discount leg posts correctly and amount_pkr consistently means
-- "gross," matching the new trigger. Idempotent — bills with discount_amount = 0
-- are untouched.
UPDATE bills SET amount_pkr = amount_pkr + discount_amount WHERE discount_amount > 0;
