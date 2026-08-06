-- Migration 127: Permanent "Website & Digital Maintenance" project — a
-- standing donation target for hosting/maintenance costs, not a one-off
-- project. No new schema; fully supported by Phase 1's per-project ledger
-- accounts (migration 118) the moment a donation is made against it.
INSERT INTO projects (title, title_ur, description, status, category, is_featured)
SELECT 'Website & Digital Maintenance', 'ویب سائٹ اور ڈیجیٹل دیکھ بھال',
       'Ongoing hosting, domain, and maintenance costs for the committee''s website and digital systems.',
       'ongoing', 'other', false
WHERE NOT EXISTS (SELECT 1 FROM projects WHERE title = 'Website & Digital Maintenance');
