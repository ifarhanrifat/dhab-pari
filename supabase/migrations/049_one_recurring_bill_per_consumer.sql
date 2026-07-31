-- Migration 049: A consumer could accidentally be set up with more than one active
-- recurring bill schedule (e.g. re-generating their first bill with "Set Recurring"
-- checked again), silently doubling their monthly charge every period. A partial
-- unique index makes this impossible at the database level regardless of which UI
-- path creates the schedule (Generate Bill or the standalone Recurring page).
CREATE UNIQUE INDEX IF NOT EXISTS recurring_schedules_one_active_bill_per_consumer
  ON recurring_schedules (consumer_id)
  WHERE is_active = true AND schedule_type = 'bill';
