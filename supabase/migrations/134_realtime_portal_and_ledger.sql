-- Migration 134: two Realtime gaps.
-- 1. portal_notifications (migration 123) was never added to the Realtime
--    publication — PortalNotificationBell.tsx's INSERT subscription has been
--    silently inert since it shipped, quietly falling back to its 30s poll
--    only. Same fix as migration 059 did for the staff `notifications` table.
-- 2. ledger_entries — needed for the new project detail page's Expenses tab
--    to update live as new project-tagged vouchers post, without a refresh.
ALTER PUBLICATION supabase_realtime ADD TABLE portal_notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE ledger_entries;
