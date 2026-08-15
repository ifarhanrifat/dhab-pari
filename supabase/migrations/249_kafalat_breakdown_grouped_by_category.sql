-- Migration 249: kafalat_child_package_breakdown() (migration 247) returned
-- one row per kafalat_package_lines row — a child with both a rate-card
-- default and a custom override for the same category (a real, normal
-- state while the committee is still tuning a package) showed as two
-- separate "Books & stationery" rows on the donor-facing card, reading like
-- a duplicate/error rather than the real total. Group by category instead —
-- the donor needs "what for" and "how much", not the line-level history.
CREATE OR REPLACE FUNCTION kafalat_child_package_breakdown(p_child_id uuid, p_academic_year varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar; v_months int; v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND status = 'active' AND NOT do_not_display;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_months := kafalat_months_remaining(v_year, c.joined_on);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('category', category, 'amount', amount) ORDER BY category), '[]'::jsonb),
         COALESCE(SUM(amount), 0)
    INTO v_lines, v_total
  FROM (
    SELECT category, SUM(CASE WHEN is_prorated THEN round(annual_amount_pkr * v_months / 12.0) ELSE annual_amount_pkr END) AS amount
    FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = v_year
    GROUP BY category
  ) grouped;

  RETURN jsonb_build_object('lines', v_lines, 'total', v_total, 'academic_year', v_year, 'months_remaining', v_months);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
