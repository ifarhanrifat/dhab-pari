-- Migration 149: Public volunteer view — volunteers itself has no public
-- SELECT into portal_users (that stays private), so a raw client join would
-- show nothing for "who volunteered." Same pattern as project_votes_public
-- (migration 137): exposes the public identity fields only (name, avatar),
-- never phone/whatsapp.
CREATE VIEW volunteers_public AS
SELECT v.id, v.project_id, v.message, v.status, v.created_at, p.full_name, p.avatar_url
FROM volunteers v JOIN portal_users p ON p.id = v.portal_user_id;

GRANT SELECT ON volunteers_public TO anon, authenticated;
