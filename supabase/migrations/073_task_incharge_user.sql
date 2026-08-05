-- Migration 073: Plumbers are payroll staff who don't use this software — an
-- installation task is assigned to a viewer-role "incharge" user instead, who
-- manually contacts the plumbers and updates task status on their behalf.
-- assignee_name/assignee_phone (migration 070) stay as optional free-text notes
-- for which physical plumber is doing the job.
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS incharge_user_id uuid REFERENCES admin_users(id);
