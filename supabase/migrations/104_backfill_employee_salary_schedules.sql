-- Migration 104: employees created before 103 have their salary recurring
-- schedule posting straight to Cash (the old immediate-cash-payment model).
-- Repoint from_account_id at their own new ledger account instead, so future
-- salary runs accrue against it like everything else now does. to_account_id
-- (WS-3001) is unchanged — only who gets credited changes.
DO $$
DECLARE r RECORD; v_account_id uuid;
BEGIN
  FOR r IN SELECT id, salary_schedule_id FROM employees WHERE salary_schedule_id IS NOT NULL LOOP
    v_account_id := ensure_employee_account(r.id);
    UPDATE recurring_schedules SET from_account_id = v_account_id WHERE id = r.salary_schedule_id;
  END LOOP;
END $$;
