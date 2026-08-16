-- Migration 261: a child's Kafalat requirement was being counted twice.
--
-- addChild() already gives a child a full 7-line package the day they're
-- registered (kafalat_default_package, migration 217) — those rows never set
-- `source` explicitly, so they land as 'manual' (migration 230's column
-- default). kafalat_generate_requirement() (fired by kafalat_approve_child(),
-- and meant for the annual rate-card refresh) only ever cleared its own
-- prior 'auto' rows before inserting a fresh rate-card set — it never
-- checked whether a manual row already covered that category. And
-- kafalat_this_year_requirement() sums every row for the child+year
-- regardless of source. So every child approved this way ended up with both
-- packages counted together.
--
-- Confirmed live: KFL-0001's requirement was posted as Rs 150,500 — his 7
-- registration-time manual lines (121,500) *plus* 7 auto lines generated
-- again at approval (~29,000 pro-rated), instead of one real figure.
--
-- Fix: generate_requirement now only fills a category that has no manual
-- figure for it yet — a manual row, wherever one exists, is already the
-- committee's real, final say for that category, exactly as this function's
-- own comment has said since migration 230 ("manual rows ... are never
-- touched by the generator"). It stops manufacturing a second, overlapping
-- figure next to one that's already there.
CREATE OR REPLACE FUNCTION kafalat_generate_requirement(p_child_id uuid, p_academic_year varchar)
RETURNS jsonb AS $$
DECLARE
  c kafalat_children%ROWTYPE;
  v_level int;
  v_tier school_fee_tiers%ROWTYPE;
  v_school_govt boolean := false;
  v_fee_annual decimal := 0;
  v_transport_annual decimal := 0;
  v_uniform decimal; v_books decimal; v_pocket decimal; v_medical decimal; v_exam decimal;
  v_prorated_total decimal := 0; v_flat_total decimal := 0;
  v_months int; v_this_year decimal;
BEGIN
  SELECT * INTO c FROM kafalat_children WHERE id = p_child_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Child not found' USING ERRCODE = 'P0001'; END IF;

  v_level := class_to_level(c.current_class);

  -- ── School fee ──────────────────────────────────────────────────────
  IF c.school_id IS NOT NULL THEN
    SELECT (kind = 'government') INTO v_school_govt FROM schools WHERE id = c.school_id;
  END IF;
  IF v_school_govt THEN
    v_fee_annual := 0;
  ELSIF c.school_id IS NOT NULL AND v_level IS NOT NULL THEN
    SELECT * INTO v_tier FROM school_fee_tiers
     WHERE school_id = c.school_id AND v_level BETWEEN class_from AND class_to
     ORDER BY class_from DESC LIMIT 1;
    IF FOUND THEN
      v_fee_annual := v_tier.monthly_fee_pkr * 12 + v_tier.annual_charges_pkr;
    END IF;
  END IF;
  IF v_fee_annual = 0 AND NOT v_school_govt THEN
    SELECT COALESCE(value::decimal, 0) INTO v_fee_annual
      FROM site_settings WHERE key = 'kafalat_default_school_fee';
  END IF;

  -- ── Transport ───────────────────────────────────────────────────────
  SELECT COALESCE(value::decimal, 0) INTO v_transport_annual FROM site_settings
   WHERE key = CASE c.school_location WHEN 'village' THEN 'kafalat_transport_village'
                                      ELSE 'kafalat_transport_chakwal' END;

  -- ── Once-a-year items, from the rate card ──────────────────────────
  SELECT COALESCE(value::decimal,0) INTO v_uniform FROM site_settings WHERE key='kafalat_default_uniform';
  SELECT COALESCE(value::decimal,0) INTO v_books FROM site_settings WHERE key='kafalat_default_books';
  SELECT COALESCE(value::decimal,0) INTO v_pocket FROM site_settings WHERE key='kafalat_default_pocket_money';
  SELECT COALESCE(value::decimal,0) INTO v_medical FROM site_settings WHERE key='kafalat_default_medical';
  SELECT COALESCE(value::decimal,0) INTO v_exam FROM site_settings WHERE key='kafalat_default_exam_fee';

  -- ── Replace the auto-generated lines; leave manual ones exactly as a
  --    committee member left them, and never add an auto line on top of
  --    a category a manual figure already covers ─────────────────────
  DELETE FROM kafalat_package_lines
   WHERE child_id = p_child_id AND academic_year = p_academic_year AND source = 'auto';

  INSERT INTO kafalat_package_lines (child_id, academic_year, category, description, annual_amount_pkr, is_prorated, source)
  SELECT p_child_id, p_academic_year, v.category, v.description, v.annual_amount_pkr, v.is_prorated, 'auto'
  FROM (VALUES
    ('school_fee', 'School fee (rate card)', v_fee_annual, true),
    ('transport', 'Transport (rate card)', v_transport_annual, true),
    ('pocket_money', 'Pocket money (rate card)', v_pocket, true),
    ('uniform', 'Uniform × 2 (rate card)', v_uniform, false),
    ('books', 'Books and stationery (rate card)', v_books, false),
    ('medical', 'Medical (rate card)', v_medical, false),
    ('exam_fee', 'Exam fee (rate card)', v_exam, false)
  ) AS v(category, description, annual_amount_pkr, is_prorated)
  WHERE NOT EXISTS (
    SELECT 1 FROM kafalat_package_lines m
     WHERE m.child_id = p_child_id AND m.academic_year = p_academic_year
       AND m.category = v.category AND m.source = 'manual'
  );

  -- ── This year's actual requirement: monthly items shrink to what is
  --    left of the year, once-a-year items are charged in full ─────────
  SELECT COALESCE(SUM(annual_amount_pkr) FILTER (WHERE is_prorated), 0),
         COALESCE(SUM(annual_amount_pkr) FILTER (WHERE NOT is_prorated), 0)
    INTO v_prorated_total, v_flat_total
    FROM kafalat_package_lines WHERE child_id = p_child_id AND academic_year = p_academic_year;

  v_months := kafalat_months_remaining(p_academic_year, c.joined_on);
  v_this_year := round(v_prorated_total * v_months / 12.0) + v_flat_total;

  RETURN jsonb_build_object(
    'academic_year', p_academic_year, 'months_remaining', v_months,
    'annual_total', v_prorated_total + v_flat_total, 'this_year_requirement', v_this_year,
    'school_fee_annual', v_fee_annual, 'transport_annual', v_transport_annual,
    'is_govt_school', v_school_govt
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION kafalat_generate_requirement(uuid, varchar) TO authenticated;

-- One-time correction for the children this already happened to: remove the
-- 'auto' rows sitting on top of a 'manual' row in the same category, and
-- post a correcting entry so the measuring account and the child's own
-- account both drop back to the real figure. Not targeted at any specific
-- child — it finds every case that exists, the same way the bug itself
-- could have hit any approved child.
DO $$
DECLARE
  r record; v_old decimal; v_new decimal; v_delta decimal; v_label text;
BEGIN
  FOR r IN
    SELECT DISTINCT a.child_id, a.academic_year FROM kafalat_package_lines a
     WHERE a.source = 'auto' AND EXISTS (
       SELECT 1 FROM kafalat_package_lines m
        WHERE m.child_id = a.child_id AND m.academic_year = a.academic_year
          AND m.category = a.category AND m.source = 'manual'
     )
  LOOP
    v_old := kafalat_this_year_requirement(r.child_id, r.academic_year);

    DELETE FROM kafalat_package_lines a
     WHERE a.child_id = r.child_id AND a.academic_year = r.academic_year
       AND a.source = 'auto' AND EXISTS (
         SELECT 1 FROM kafalat_package_lines m
          WHERE m.child_id = a.child_id AND m.academic_year = a.academic_year
            AND m.category = a.category AND m.source = 'manual'
       );

    v_new := kafalat_this_year_requirement(r.child_id, r.academic_year);
    v_delta := v_new - v_old;
    IF v_delta <> 0 THEN
      SELECT first_name || ' (' || code || ')' INTO v_label FROM kafalat_children WHERE id = r.child_id;
      PERFORM kafalat_post_requirement_delta(
        r.academic_year, v_delta,
        COALESCE(v_label, 'Child') || ' — correction: duplicate package lines removed',
        r.child_id
      );
    END IF;
  END LOOP;
END $$;
