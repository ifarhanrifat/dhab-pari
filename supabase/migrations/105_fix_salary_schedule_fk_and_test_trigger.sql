-- Migration 105: employees.salary_schedule_id (migration 101) was left as a
-- plain REFERENCES with no ON DELETE behavior — every other recurring_schedule_id
-- column in this app (bills, donors, vouchers) uses ON DELETE SET NULL so
-- deleting the schedule from the Recurring page cleanly detaches it instead
-- of failing. Caught live: deleting an employee's salary schedule from either
-- /admin/recurring or /admin/finance/water_supply/recurring would raise a raw
-- foreign-key violation instead of succeeding.
ALTER TABLE employees DROP CONSTRAINT employees_salary_schedule_id_fkey;
ALTER TABLE employees ADD CONSTRAINT employees_salary_schedule_id_fkey
  FOREIGN KEY (salary_schedule_id) REFERENCES recurring_schedules(id) ON DELETE SET NULL;
