-- Migration 070: Installation task tracking for a connection request between
-- Cash Receive (status='processing') and Activate (status='installed'). The
-- assignee is a plain name/phone, not a login — management updates status on
-- their behalf. No new RLS needed: these are more columns on connection_requests,
-- already covered by its existing edit_transactions-gated UPDATE policy.
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_status varchar NOT NULL DEFAULT 'unassigned'
  CHECK (task_status IN ('unassigned', 'assigned', 'in_progress', 'done'));
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS assignee_name varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS assignee_phone varchar;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_notes text;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_due_date date;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_assigned_at timestamptz;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_started_at timestamptz;
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS task_done_at timestamptz;
