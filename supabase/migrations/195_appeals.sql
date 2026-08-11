-- Migration 195: appeals — one urgent-message system, for any cause, aimed at
-- whichever part of the village needs to hear it.
--
-- ── Why this is not just "another ticker row" ────────────────────────────
-- The blood appeal already worked: it wrote a news_ticker row and the row was
-- there, active, and readable by anonymous visitors. It was still invisible in
-- practice, because the announcement bar concatenates every active message —
-- in both languages — into a single scrolling line. An emergency appeal became
-- the eighth item in a two-minute loop, in the same colour as "Free medical
-- camp every Tuesday".
--
-- An appeal is a different kind of thing from an announcement and needs to be
-- stored as one: it is urgent, it expires, it is aimed at particular people,
-- and it has to be retractable the moment the need is met.
--
-- ── Audience ─────────────────────────────────────────────────────────────
-- A water-supply outage does not concern an overseas donor, and a request for
-- maintenance funds should not go to the consumers who already pay a monthly
-- bill. Sending everything to everyone is how people learn to ignore all of it.
CREATE TABLE IF NOT EXISTS appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  kind varchar NOT NULL DEFAULT 'other'
    CHECK (kind IN ('blood', 'medical', 'project', 'maintenance', 'other')),

  title_en varchar,
  title_ur varchar,
  body_en text NOT NULL,
  body_ur text NOT NULL,

  -- 'villagers' is by donor_type, not by whether they hold an account: a
  -- villager is a villager whether they pay a water bill, donate, or neither.
  audience varchar NOT NULL DEFAULT 'everyone'
    CHECK (audience IN ('everyone', 'consumers', 'donors', 'villagers', 'overseas')),
  -- Only consulted for 'overseas'. Empty means every country.
  audience_countries text[] NOT NULL DEFAULT '{}',

  -- Whether it also goes on the public website, as opposed to only inside the
  -- portal. A targeted appeal usually should not be public.
  is_public boolean NOT NULL DEFAULT true,

  contact_name varchar,
  contact_number varchar,

  blood_request_id uuid REFERENCES blood_requests(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  ticker_id uuid REFERENCES news_ticker(id) ON DELETE SET NULL,

  status varchar NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  -- An appeal for blood needed on Tuesday is noise on Wednesday. Optional, but
  -- the blood path always sets it.
  expires_at timestamptz,

  created_by_admin_user_id uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by_admin_user_id uuid REFERENCES admin_users(id),
  closed_at timestamptz,
  close_reason text
);

CREATE INDEX IF NOT EXISTS appeals_active_idx ON appeals(status, expires_at) WHERE status = 'active';

ALTER TABLE appeals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "appeals_staff_read" ON appeals FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true));
CREATE POLICY "appeals_manage" ON appeals FOR ALL TO authenticated
  USING (current_admin_permission('manage_parties') OR current_admin_permission('manage_blood_requests'))
  WITH CHECK (current_admin_permission('manage_parties') OR current_admin_permission('manage_blood_requests'));

-- ── Reading ──────────────────────────────────────────────────────────────
-- Public site: only appeals explicitly marked public, and never anything that
-- identifies a person. The body is composed at creation with that already
-- applied, so there is nothing to strip here.
CREATE OR REPLACE FUNCTION public_appeals()
RETURNS TABLE (id uuid, kind text, title_en text, title_ur text, body_en text, body_ur text,
               contact_number text, created_at timestamptz) AS $$
  SELECT a.id, a.kind::text, a.title_en::text, a.title_ur::text, a.body_en, a.body_ur,
         a.contact_number::text, a.created_at
    FROM appeals a
   WHERE a.status = 'active'
     AND a.is_public
     AND (a.expires_at IS NULL OR a.expires_at > now())
   ORDER BY a.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public_appeals() TO anon, authenticated;

-- Portal: everything aimed at this particular user, public or not.
CREATE OR REPLACE FUNCTION my_appeals()
RETURNS TABLE (id uuid, kind text, title_en text, title_ur text, body_en text, body_ur text,
               contact_number text, created_at timestamptz) AS $$
DECLARE
  u portal_users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM portal_users WHERE auth_user_id = auth.uid() AND is_active = true;
  IF u.id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT a.id, a.kind::text, a.title_en::text, a.title_ur::text, a.body_en, a.body_ur,
         a.contact_number::text, a.created_at
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
   ORDER BY a.created_at DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_appeals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_appeals() TO authenticated;

-- ── Writing ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_appeal(
  p_kind varchar,
  p_body_ur text,
  p_body_en text,
  p_audience varchar DEFAULT 'everyone',
  p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true,
  p_title_ur varchar DEFAULT NULL,
  p_title_en varchar DEFAULT NULL,
  p_contact_name varchar DEFAULT NULL,
  p_contact_number varchar DEFAULT NULL,
  p_project_id uuid DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_id uuid;
  v_admin uuid;
  v_ticker uuid;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to post an appeal';
  END IF;
  IF coalesce(trim(p_body_ur), '') = '' OR coalesce(trim(p_body_en), '') = '' THEN
    RAISE EXCEPTION 'An appeal needs wording in both Urdu and English';
  END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, title_en, title_ur, body_en, body_ur, audience, audience_countries,
                       is_public, contact_name, contact_number, project_id, expires_at,
                       created_by_admin_user_id)
  VALUES (p_kind, p_title_en, p_title_ur, trim(p_body_en), trim(p_body_ur), p_audience,
          coalesce(p_audience_countries, '{}'), p_is_public, p_contact_name, p_contact_number,
          p_project_id, p_expires_at, v_admin)
  RETURNING id INTO v_id;

  -- A public appeal also joins the website ticker, so a visitor who never logs
  -- in still sees it. display_order -100 puts it ahead of routine notices.
  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (trim(p_body_en), trim(p_body_ur), true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION close_appeal(p_appeal_id uuid, p_reason text DEFAULT NULL)
RETURNS void AS $$
DECLARE a appeals%ROWTYPE;
BEGIN
  IF (current_admin_permission('manage_parties') IS DISTINCT FROM true)
     AND (current_admin_permission('manage_blood_requests') IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'You do not have permission to close an appeal';
  END IF;

  SELECT * INTO a FROM appeals WHERE id = p_appeal_id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Appeal not found'; END IF;

  UPDATE appeals SET status = 'closed', closed_at = now(),
                     closed_by_admin_user_id = current_admin_user_id(),
                     close_reason = p_reason
   WHERE id = p_appeal_id;

  -- The ticker goes with it. An appeal that stays up after the need is met is
  -- worse than one that was never posted — it teaches people the appeals are
  -- stale and can be skipped.
  UPDATE news_ticker SET is_active = false WHERE id = a.ticker_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION close_appeal(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION close_appeal(uuid, text) TO authenticated;

-- ── Blood appeals go through the same system ─────────────────────────────
-- Replaces post_blood_request_ticker, whose text named no patient but also
-- described none, said nothing about how much blood or when, and went into the
-- general announcement loop. The wording now comes from migration 194's
-- builders, so the appeal, the donor notification and the portal banner all
-- say the same thing.
CREATE OR REPLACE FUNCTION post_blood_appeal(
  p_request_id uuid,
  p_contact_number varchar DEFAULT NULL,
  p_audience varchar DEFAULT 'everyone',
  p_audience_countries text[] DEFAULT '{}',
  p_is_public boolean DEFAULT true
) RETURNS uuid AS $$
DECLARE
  r blood_requests%ROWTYPE;
  v_id uuid;
  v_admin uuid;
  v_ticker uuid;
BEGIN
  IF current_admin_permission('manage_blood_requests') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'You do not have permission to post a blood appeal';
  END IF;

  SELECT * INTO r FROM blood_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'open' THEN RAISE EXCEPTION 'Only an open request can be posted publicly'; END IF;

  v_admin := current_admin_user_id();

  INSERT INTO appeals (kind, title_en, title_ur, body_en, body_ur, audience, audience_countries,
                       is_public, contact_name, contact_number, blood_request_id,
                       -- Blood is needed on a day; the appeal dies at the end of it.
                       expires_at, created_by_admin_user_id)
  VALUES ('blood',
          r.blood_group || ' blood needed', r.blood_group || ' خون کی ضرورت',
          blood_appeal_text_en(p_request_id, p_contact_number),
          blood_appeal_text_ur(p_request_id, p_contact_number),
          p_audience, coalesce(p_audience_countries, '{}'), p_is_public,
          r.requester_name, coalesce(nullif(trim(coalesce(p_contact_number, '')), ''), r.requester_whatsapp),
          p_request_id,
          ((r.needed_on + 1)::timestamp AT TIME ZONE 'Asia/Karachi'),
          v_admin)
  RETURNING id INTO v_id;

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (blood_appeal_text_en(p_request_id, p_contact_number),
            blood_appeal_text_ur(p_request_id, p_contact_number),
            true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
    UPDATE blood_requests SET ticker_id = v_ticker WHERE id = p_request_id;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION post_blood_appeal(uuid, varchar, varchar, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION post_blood_appeal(uuid, varchar, varchar, text[], boolean) TO authenticated;

-- ── Closing the request closes its appeal ────────────────────────────────
-- cancel_blood_request and fulfil_blood_request already deactivated the ticker
-- row. Now they also close the appeal, so it stops showing in every portal —
-- which is the user-visible half of "the ticker will be removed too".
CREATE OR REPLACE FUNCTION close_appeals_for_blood_request(p_request_id uuid, p_reason text)
RETURNS void AS $$
  UPDATE appeals SET status = 'closed', closed_at = now(), close_reason = p_reason
   WHERE blood_request_id = p_request_id AND status = 'active';
  UPDATE news_ticker SET is_active = false
   WHERE id IN (SELECT ticker_id FROM appeals WHERE blood_request_id = p_request_id AND ticker_id IS NOT NULL);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

DO $fix$
DECLARE fn text; src text; newsrc text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['cancel_blood_request', 'fulfil_blood_request'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = fn LIMIT 1;
    IF src IS NULL THEN RAISE EXCEPTION 'blood appeal close: % not found', fn; END IF;

    -- Both functions contain this exact line (migration 189) to pull the
    -- ticker down; the appeal close goes immediately after it.
    newsrc := replace(
      src,
      'UPDATE news_ticker SET is_active = false WHERE id IN (r.ticker_id);',
      'UPDATE news_ticker SET is_active = false WHERE id IN (r.ticker_id);' || chr(10) ||
      '  PERFORM close_appeals_for_blood_request(p_request_id, ''request closed'');'
    );
    IF newsrc = src THEN
      RAISE EXCEPTION 'blood appeal close: expected ticker line not found in % — refusing to guess', fn;
    END IF;
    EXECUTE newsrc;
    RAISE NOTICE 'appeal auto-close wired into %', fn;
  END LOOP;
END $fix$;
