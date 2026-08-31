-- Every project already carries a bilingual title (title/title_ur) and
-- description (description/description_ur) — location never got the same
-- treatment, so whatever an admin typed into "Location" (often English —
-- "Village Community Hall") showed up raw, embedded mid-sentence, on every
-- otherwise-Urdu project card and detail page. Same gap on a training
-- batch's schedule_note ("Village Community Hall · Sun,Mon..."), which
-- already has label/label_ur but not schedule_note/schedule_note_ur.
--
-- Both new columns are optional — an admin who only fills the English side
-- (as most have so far) sees no behavior change; Urdu mode just falls back
-- to the English text exactly as it does today, until the Urdu value is
-- filled in.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS location_ur text;
ALTER TABLE training_batches ADD COLUMN IF NOT EXISTS schedule_note_ur text;

-- training_batches_for_join(): unchanged signature/return type (jsonb), so
-- CREATE OR REPLACE is safe without a DROP FUNCTION first — just adding a
-- key to the jsonb payload, not changing what the function accepts/returns.
CREATE OR REPLACE FUNCTION training_batches_for_join(p_project_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'label', b.label, 'label_ur', b.label_ur, 'schedule_note', b.schedule_note, 'schedule_note_ur', b.schedule_note_ur,
    'age_min', b.age_min, 'age_max', b.age_max, 'session_days', b.session_days, 'session_time', b.session_time,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct,
    'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.project_id = p_project_id AND b.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION training_batches_public() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', b.id, 'project_id', b.project_id, 'label', b.label, 'label_ur', b.label_ur,
    'schedule_note', b.schedule_note, 'schedule_note_ur', b.schedule_note_ur, 'age_min', b.age_min, 'age_max', b.age_max,
    'fee_villager_monthly_pkr', b.fee_villager_monthly_pkr, 'fee_outsider_monthly_pkr', b.fee_outsider_monthly_pkr,
    'fee_villager_full_pkr', b.fee_villager_full_pkr, 'fee_outsider_full_pkr', b.fee_outsider_full_pkr,
    'sibling_discount_pct', b.sibling_discount_pct, 'capacity', b.capacity,
    'spots_left', CASE WHEN b.capacity IS NULL THEN NULL ELSE
      greatest(0, b.capacity - (SELECT count(*) FROM training_enrollments e
                                  WHERE e.batch_id = b.id AND e.status IN ('pending', 'active'))) END
  ) ORDER BY b.label), '[]'::jsonb)
  FROM training_batches b WHERE b.status = 'active';
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
