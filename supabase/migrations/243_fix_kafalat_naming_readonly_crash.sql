-- Migration 243: kafalat_children_for_naming() has been crashing on every
-- real call since migration 236 — a serious, live bug just caught by an
-- actual end-to-end test.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why every donor landing on /portal/kafalat only ever saw "join the shared
-- pool", never an actual child
-- ═════════════════════════════════════════════════════════════════════════
-- kafalat_generate_requirement() (migration 230) was written to run at
-- specific write moments — approving a child, the annual rate-card refresh —
-- and it does exactly that: DELETE the child's auto-generated package lines,
-- INSERT them fresh, then return the total. migration 236's
-- kafalat_children_for_naming() called it inline, per child, purely to read
-- "how much does this child still need" for the browsing list.
--
-- PostgREST runs RPC calls in a read-only transaction. A DELETE inside a
-- function invoked that way fails outright — confirmed live just now:
-- {"code":"25006","message":"cannot execute DELETE in a read-only
-- transaction"}. Every dry-run test this session ran the same SQL through a
-- plain psql session (always read-write), so this never surfaced until a
-- real donor actually used the real page.
--
-- The fix: read what generate_requirement already wrote (approving a child
-- already populates kafalat_package_lines; editing the package edits it
-- again) instead of regenerating it on every page view. A "list children to
-- sponsor" call has no business deleting anything, and doing so also meant
-- any committee edit to a child's package was liable to be silently
-- overwritten the next time anyone merely looked at the donor page.
CREATE OR REPLACE FUNCTION kafalat_this_year_requirement(p_child_id uuid, p_academic_year varchar)
RETURNS decimal AS $$
DECLARE
  c kafalat_children%ROWTYPE;
  v_prorated_total decimal := 0; v_flat_total decimal := 0; v_months int;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(annual_amount_pkr) FILTER (WHERE is_prorated), 0),
         COALESCE(SUM(annual_amount_pkr) FILTER (WHERE NOT is_prorated), 0)
    INTO v_prorated_total, v_flat_total
    FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = p_academic_year;

  v_months := kafalat_months_remaining(p_academic_year, c.joined_on);
  RETURN round(v_prorated_total * v_months / 12.0) + v_flat_total;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_this_year_requirement(uuid, varchar) TO anon, authenticated;

CREATE OR REPLACE FUNCTION kafalat_children_for_naming() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'code', c.code, 'first_name', c.first_name, 'first_name_ur', c.first_name_ur,
    'current_class', c.current_class, 'is_orphan', c.is_orphan,
    'photo_url', CASE WHEN c.photo_consent AND NOT c.do_not_display THEN c.photo_url ELSE NULL END,
    'this_year_requirement', kafalat_this_year_requirement(c.id, kafalat_current_year()),
    'already_named', COALESCE((
      SELECT SUM(p.amount_pkr) FROM pool_payments p
       WHERE p.kafalat_child_id = c.id AND p.status = 'confirmed'
         AND p.for_month >= date_trunc('year', (now() AT TIME ZONE 'Asia/Karachi')::date) - interval '9 months'
    ), 0)
  ) ORDER BY c.code), '[]'::jsonb)
  FROM kafalat_children c WHERE c.status = 'active' AND NOT c.do_not_display;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_children_for_naming() TO anon, authenticated;

-- /admin/kafalat's own child list calls this same function for its "how
-- much of this child's requirement is covered" figure, so it was hit by the
-- identical bug — fixed the same way, by the same change above.
