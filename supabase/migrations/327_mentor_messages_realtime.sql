-- Migration 327: mentor_messages needs realtime for the chat page to show
-- an incoming message without a manual refresh — same mechanism as
-- portal_notifications/project_comments (migrations 134, 138).
ALTER PUBLICATION supabase_realtime ADD TABLE mentor_messages;
