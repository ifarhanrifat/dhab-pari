-- Migration 116: Public donation submission — storage bucket for payment
-- receipts, a database-enforced "project must be launched" gate, and a
-- privacy-safe public view replacing donors' previously-unrestricted public
-- SELECT policy. `donors` gained WhatsApp/father's-name/receipt-URL fields in
-- migration 115; the old `public_read_donors USING (true)` policy (migration
-- 002, never revoked) would have exposed all of it to anyone querying the
-- table directly — this closes that before turning on public writes.

-- 1. Storage bucket for payment screenshots. NOT public-read (may show
--    account numbers/other names) — only staff with donors_projects access
--    can view; anon/authenticated can upload (the submitter has no session
--    yet to prove who they are, same trust level the public `suggestions`
--    table already operates at).
INSERT INTO storage.buckets (id, name, public) VALUES ('donation_receipts', 'donation_receipts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can upload donation receipts" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'donation_receipts');
CREATE POLICY "Staff can read donation receipts" ON storage.objects FOR SELECT
  USING (bucket_id = 'donation_receipts' AND can_access_system('donors_projects'));
CREATE POLICY "Staff can delete donation receipts" ON storage.objects FOR DELETE
  USING (bucket_id = 'donation_receipts' AND can_access_system('donors_projects'));

-- 2. Donations only enabled once a project has actually launched — checked
--    at the database level since the submitter is unauthenticated and the
--    client can't be trusted to enforce this on its own.
CREATE OR REPLACE FUNCTION project_accepts_donations(p_project_id uuid) RETURNS boolean AS $$
  SELECT p_project_id IS NULL OR EXISTS (
    SELECT 1 FROM projects WHERE id = p_project_id AND status <> 'upcoming'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 3. Public submission — additive alongside the existing staff `donors_write`
--    policy from migration 014 (permissive policies OR together, so staff
--    inserts via the admin form are unaffected). Public rows always land
--    unverified and tagged submitted_via='public'; is_verified only ever
--    flips true through confirm_donation() (migration 117), never a raw
--    client update, so no public UPDATE grant is needed.
CREATE POLICY "donors_public_submit" ON donors FOR INSERT TO anon, authenticated
  WITH CHECK (is_verified = false AND submitted_via = 'public' AND project_accepts_donations(project_id));

-- 4. Close the PII leak: drop the blanket public SELECT from migration 002,
--    replace it with a view exposing only what the public site actually
--    needs (name suppressed when anonymous; no phone/WhatsApp/father's
--    name/receipt URL ever leaves the server). Not security_invoker — it
--    intentionally reads past donors' now-staff-only RLS (owned by the
--    migration role) so the public can still see the honor wall / announced
--    funds, just through this narrow, deliberately-chosen column list.
DROP POLICY IF EXISTS "public_read_donors" ON donors;

CREATE OR REPLACE VIEW donors_public AS
SELECT id,
       CASE WHEN is_anonymous THEN 'Anonymous' ELSE name END AS name,
       CASE WHEN is_anonymous THEN NULL ELSE name_ur END AS name_ur,
       amount_pkr, date, project_id, donor_type, is_verified
FROM donors;

GRANT SELECT ON donors_public TO anon, authenticated;
