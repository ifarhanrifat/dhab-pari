-- Migration 198: stop the appeal saying "a patient (patient)".
--
-- blood_patient_label_* falls back to 'مریض' / 'patient' when patient_kind is
-- NULL, which is right for a label but wrong inside the parenthetical the
-- appeal builders wrap it in. Requests raised before 194 have no patient_kind,
-- so the live open request currently reads:
--
--   ڈھاب پڑی کے ایک مریض (مریض) کے لیے ...
--   A villager (patient) needs ...
--
-- The parenthetical exists to say *which kind* of villager. With nothing to
-- say, it should not appear at all.
CREATE OR REPLACE FUNCTION blood_appeal_text_ur(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE r blood_requests%ROWTYPE; v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_when := blood_day_ur(r.needed_on)
            || COALESCE(' ' || blood_time_ur(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();
  v_who := 'ایک مریض' || COALESCE(' (' || blood_patient_label_ur(r.patient_kind) || ')', '');

  RETURN 'ڈھاب پڑی کے ' || v_who || ' کے لیے '
      || r.blood_group || ' خون کی ' || r.units_needed::text || ' '
      || CASE WHEN r.units_needed = 1 THEN 'بوتل' ELSE 'بوتلیں' END || ' درکار ہیں — '
      || v_when || '، ' || r.hospital || '، ' || r.city || '۔ '
      || 'رابطہ: ' || v_contact
      || COALESCE(' یا کمیٹی: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION blood_appeal_text_en(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE r blood_requests%ROWTYPE; v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_when := blood_day_en(r.needed_on)
            || COALESCE(' at ' || blood_time_en(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();
  v_who := 'A villager' || COALESCE(' (' || blood_patient_label_en(r.patient_kind) || ')', '');

  RETURN v_who || ' needs '
      || r.units_needed::text || ' unit' || CASE WHEN r.units_needed = 1 THEN '' ELSE 's' END
      || ' of ' || r.blood_group || ' blood — ' || v_when || ', '
      || r.hospital || ', ' || r.city || '. '
      || 'Contact: ' || v_contact
      || COALESCE(' or the committee: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Return NULL rather than a generic word, so COALESCE above can drop the whole
-- parenthetical. The donor notification in approve_blood_request uses the same
-- helper inside its own '(' || ... || ')' — NULL there collapses that string to
-- NULL, so it is wrapped the same way.
CREATE OR REPLACE FUNCTION blood_patient_label_ur(p_kind varchar) RETURNS text AS $$
  SELECT CASE p_kind
    WHEN 'man'   THEN 'مرد'
    WHEN 'woman' THEN 'خاتون'
    WHEN 'child' THEN 'بچے'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blood_patient_label_en(p_kind varchar) RETURNS text AS $$
  SELECT CASE p_kind
    WHEN 'man'   THEN 'man'
    WHEN 'woman' THEN 'woman'
    WHEN 'child' THEN 'child'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

-- approve_blood_request builds 'ایک مریض (' || label || ')' inline, which now
-- yields NULL for an unknown kind and would blank the whole notification body.
-- Same COALESCE treatment, applied to its own current definition rather than
-- retyping the body.
DO $fix$
DECLARE src text; newsrc text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_blood_request' LIMIT 1;
  IF src IS NULL THEN RAISE EXCEPTION 'approve_blood_request not found'; END IF;

  newsrc := replace(
    src,
    '''ڈھاب پڑی کے ایک مریض ('' || blood_patient_label_ur(r.patient_kind) || '') کے لیے '' ||',
    '''ڈھاب پڑی کے ایک مریض'' || COALESCE('' ('' || blood_patient_label_ur(r.patient_kind) || '')'', '''') || '' کے لیے '' ||'
  );
  IF newsrc = src THEN
    RAISE EXCEPTION 'approve_blood_request: patient label pattern not found — refusing to guess';
  END IF;
  EXECUTE newsrc;
  RAISE NOTICE 'approve_blood_request: patient label now omitted when unknown';
END $fix$;
