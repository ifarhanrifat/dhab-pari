-- Migration 059: Enable Supabase Realtime on notifications so the bell (and
-- Phase 4's approver alerts, which reuse this table) push instantly instead of
-- waiting for the client's next poll — this is what "true real-time popup alert
-- when online" actually requires, on any device including mobile browsers.
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
