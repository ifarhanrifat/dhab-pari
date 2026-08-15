-- Migration 247: "what is this Rs 150,500 actually made of" — the donor-
-- facing budget breakdown, as opposed to kafalat_child_public_expense_summary
-- (migration 244), which only shows what has actually been spent so far.
-- A donor looking at a child's card sees an annual figure with nothing
-- behind it; this is the line-by-line answer, using the same package the
-- committee itself set (kafalat_package_lines), prorated exactly the same
-- way kafalat_this_year_requirement() already computes the headline total —
-- the two are guaranteed to add up to the same number.
CREATE OR REPLACE FUNCTION kafalat_child_package_breakdown(p_child_id uuid, p_academic_year varchar DEFAULT NULL)
RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE; v_year varchar; v_months int; v_lines jsonb; v_total decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id AND status = 'active' AND NOT do_not_display;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  v_year := COALESCE(p_academic_year, kafalat_current_year());
  v_months := kafalat_months_remaining(v_year, c.joined_on);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category', category, 'description', description,
    'amount', CASE WHEN is_prorated THEN round(annual_amount_pkr * v_months / 12.0) ELSE annual_amount_pkr END,
    'is_prorated', is_prorated
  ) ORDER BY category), '[]'::jsonb)
    INTO v_lines
  FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = v_year;

  SELECT COALESCE(SUM((x->>'amount')::decimal), 0) INTO v_total FROM jsonb_array_elements(v_lines) x;

  RETURN jsonb_build_object('lines', v_lines, 'total', v_total, 'academic_year', v_year, 'months_remaining', v_months);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION kafalat_child_package_breakdown(uuid, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kafalat_child_package_breakdown(uuid, varchar) TO anon, authenticated;
