-- Migration 199: the appeal, phrased the way it would be said out loud.
--
-- The previous wording was assembled in the order the columns happen to sit in
-- the table — "for a patient, N units, — when, hospital, city" — with an em
-- dash doing the work a verb should do. Read aloud in Urdu it lands as a list
-- of fields rather than a sentence.
--
-- Rewritten to the natural order a villager would use: who, when, where, what
-- is needed, then who to ring.
--
--   ڈھاب پڑی گاؤں کے ایک مریض (عورت) کو کل صبح 10 بجے راولپنڈی کے سی ایم ایچ
--   ہسپتال میں A+ خون کی 4 یونٹ کی ضرورت ہے۔ اس کے لیے رابطہ کریں: 03xx یا
--   کمیٹی واٹس ایپ نمبر: 03xx
--
-- Also: مرد/خاتون → آدمی/عورت/بچے, which is what people actually say here, and
-- بوتل → یونٹ to match how blood is asked for at a hospital counter.
CREATE OR REPLACE FUNCTION blood_patient_label_ur(p_kind varchar) RETURNS text AS $$
  SELECT CASE p_kind
    WHEN 'man'   THEN 'آدمی'
    WHEN 'woman' THEN 'عورت'
    WHEN 'child' THEN 'بچے'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION blood_appeal_text_ur(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_who := 'ڈھاب پڑی گاؤں کے ایک مریض'
        || COALESCE(' (' || blood_patient_label_ur(r.patient_kind) || ')', '');
  v_when := blood_day_ur(r.needed_on)
        || COALESCE(' ' || blood_time_ur(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN v_who || ' کو ' || v_when || ' '
      || r.city || ' کے ' || r.hospital || ' میں '
      || r.blood_group || ' خون کی ' || r.units_needed::text || ' یونٹ کی ضرورت ہے۔ '
      || 'اس کے لیے رابطہ کریں: ' || v_contact
      || COALESCE(' یا کمیٹی واٹس ایپ نمبر: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION blood_appeal_text_en(p_request_id uuid, p_contact_number varchar DEFAULT NULL)
RETURNS text AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_when text; v_contact text; v_committee text; v_who text;
BEGIN
  SELECT * INTO r FROM blood_requests WHERE id = p_request_id;
  IF r.id IS NULL THEN RETURN NULL; END IF;

  v_who := 'A patient' || COALESCE(' (' || blood_patient_label_en(r.patient_kind) || ')', '')
        || ' from Dhab Pari village';
  v_when := blood_day_en(r.needed_on)
        || COALESCE(' at ' || blood_time_en(r.needed_hour, r.needed_period, r.needed_time), '');
  v_contact := COALESCE(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp);
  v_committee := committee_contact_number();

  RETURN v_who || ' needs ' || r.units_needed::text || ' unit'
      || CASE WHEN r.units_needed = 1 THEN '' ELSE 's' END
      || ' of ' || r.blood_group || ' blood ' || v_when
      || ' at ' || r.hospital || ', ' || r.city || '. '
      || 'Please contact ' || v_contact
      || COALESCE(' or the committee on WhatsApp: ' || v_committee, '');
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- The donor notification says بوتل too. Same change, applied to the function's
-- own current definition rather than retyping a body that has been rewritten
-- several times already.
DO $fix$
DECLARE src text; newsrc text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'approve_blood_request' LIMIT 1;
  IF src IS NULL THEN RAISE EXCEPTION 'approve_blood_request not found'; END IF;

  newsrc := replace(src,
    'CASE WHEN r.units_needed = 1 THEN ''بوتل'' ELSE ''بوتلیں'' END || '' درکار ہیں۔''',
    '''یونٹ کی ضرورت ہے۔''');

  IF newsrc = src THEN
    RAISE WARNING 'approve_blood_request: unit wording not found, left as it was';
  ELSE
    EXECUTE newsrc;
    RAISE NOTICE 'approve_blood_request: بوتل -> یونٹ';
  END IF;
END $fix$;

-- ── What to call an appeal ───────────────────────────────────────────────
-- Displayed as the label in front of the scrolling text, so a reader knows in
-- one word whether to stop and read or carry on.
ALTER TABLE appeals
  ADD COLUMN IF NOT EXISTS severity varchar NOT NULL DEFAULT 'appeal'
    CHECK (severity IN ('emergency', 'important', 'appeal'));

-- Blood is always an emergency; nobody raises one in advance for fun.
UPDATE appeals SET severity = 'emergency' WHERE kind = 'blood' AND severity = 'appeal';

-- Dropped first: CREATE OR REPLACE cannot change a RETURNS TABLE signature,
-- and adding `severity` changes it. Same reason my_appeals is dropped below.
DROP FUNCTION IF EXISTS public_appeals();

CREATE OR REPLACE FUNCTION public_appeals()
RETURNS TABLE (id uuid, kind text, severity text, title_en text, title_ur text,
               body_en text, body_ur text, contact_number text, created_at timestamptz) AS $$
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.status = 'active'
     AND a.is_public
     AND (a.expires_at IS NULL OR a.expires_at > now())
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_appeals() TO anon, authenticated;

DROP FUNCTION IF EXISTS my_appeals();
CREATE OR REPLACE FUNCTION my_appeals()
RETURNS TABLE (id uuid, kind text, severity text, title_en text, title_ur text,
               body_en text, body_ur text, contact_number text, created_at timestamptz) AS $$
DECLARE u portal_users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF u.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.kind::text, a.severity::text, a.title_en::text, a.title_ur::text,
         a.body_en, a.body_ur, a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.status = 'active'
     AND (a.expires_at IS NULL OR a.expires_at > now())
     AND CASE a.audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(a.audience_countries) = 0
                                  OR u.country = ANY (a.audience_countries))
       ELSE false
     END
   ORDER BY CASE a.severity WHEN 'emergency' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,
            a.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_appeals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_appeals() TO authenticated;

-- create_appeal and post_blood_appeal gain the severity, defaulted so existing
-- callers keep working.
CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar, p_body_ur text, p_body_en text,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true, p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL, p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL, p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL, p_notify boolean DEFAULT true,
  p_severity varchar DEFAULT 'appeal'
) RETURNS uuid AS $$
DECLARE v_id uuid; v_admin uuid; v_ticker uuid;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' OR coalesce(trim(p_body_en), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in both Urdu and English';
  END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       project_id, expires_at, created_by_admin_user_id)
  VALUES (p_kind, p_severity, p_title_en, p_title_ur, trim(p_body_en), trim(p_body_ur),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name,
          p_contact_number, p_project_id, p_expires_at, v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (trim(p_body_en), trim(p_body_ur), true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''),
                    nullif(trim(coalesce(p_title_en, '')), ''), 'ایک اپیل'),
           trim(p_body_ur) || chr(10) || trim(p_body_en),
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP FUNCTION IF EXISTS create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean);
REVOKE ALL ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION post_blood_appeal(
  p_request_id uuid, p_contact_number varchar DEFAULT NULL,
  p_audience varchar DEFAULT 'everyone', p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true
) RETURNS uuid AS $$
DECLARE r blood_requests%ROWTYPE; v_id uuid; v_admin uuid; v_ticker uuid;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, severity, title_en, title_ur, body_en, body_ur, audience,
                       audience_countries, is_public, contact_name, contact_number,
                       blood_request_id, expires_at, created_by_admin_user_id)
  VALUES ('blood', 'emergency',
          r.blood_group || ' blood needed', r.blood_group || ' خون کی ضرورت',
          blood_appeal_text_en(p_request_id, p_contact_number),
          blood_appeal_text_ur(p_request_id, p_contact_number),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public,
          r.requester_name,
          coalesce(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp),
          p_request_id,
          ((r.needed_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi'), v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (blood_appeal_text_en(p_request_id, p_contact_number),
            blood_appeal_text_ur(p_request_id, p_contact_number), true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
    UPDATE blood_requests SET ticker_id = v_ticker WHERE id = p_request_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION post_blood_appeal(uuid, varchar, varchar, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_blood_appeal(uuid, varchar, varchar, text[], boolean) TO authenticated;
