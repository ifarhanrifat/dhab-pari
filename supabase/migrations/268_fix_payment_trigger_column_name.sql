-- Migration 268: trg_period_lock_payments() has referenced a column that
-- doesn't exist since the day it was written (migration 204) --
-- NEW.payment_date/OLD.payment_date, when the real column on `payments` is
-- paid_date. PL/pgSQL evaluates that field access before assert_period_open()
-- is even called, so this fires on every single insert/update/delete to
-- payments, unconditionally -- independent of whether the period lock
-- itself is on or off (migration 266 did not fix this; the crash happens
-- before the lock check is ever reached).
--
-- Confirmed against live data: the last payment that actually went through
-- was receipt #0060 on 12 Aug — nothing since, for six days, on any water
-- bill. WB-00564 (the report that surfaced this) is untouched otherwise:
-- paid_amount is still 0, no partial/inconsistent state -- the payment
-- insert simply never happened, cleanly.
--
-- trg_period_lock_vouchers (voucher_date) and trg_period_lock_donors (date)
-- were checked too and are correct -- this typo was isolated to the one
-- trigger.
CREATE OR REPLACE FUNCTION trg_period_lock_payments() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_period_open(OLD.paid_date, 'This receipt');
    RETURN OLD;
  END IF;
  PERFORM assert_period_open(NEW.paid_date, 'This receipt');
  IF TG_OP = 'UPDATE' THEN PERFORM assert_period_open(OLD.paid_date, 'This receipt'); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
