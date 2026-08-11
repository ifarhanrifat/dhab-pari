-- Migration 196: an appeal also reaches people who are not looking at the site.
--
-- The Alerts screen already had "Send Portal Emergency Alert", whose own
-- placeholder text read "e.g. Urgent: Medical Emergency Appeal" — so appeals
-- were what it was for. It just did something weaker than intended: it went to
-- every portal user with no targeting, arrived as a single bell notification
-- that scrolls away, could not be taken back, and never reached the public
-- site.
--
-- Rather than leave two half-overlapping features on the same page, appeals
-- take that job over. What was missing from the appeals side is the push: the
-- red banner only works for someone who opens the portal. This adds the
-- notification, aimed at the same audience as the banner.

-- Who an appeal is for. One definition, used by the banner (my_appeals), the
-- notification, and the size preview on the compose screen — three copies of
-- this rule would drift the first time a role was added.
CREATE OR REPLACE FUNCTION appeal_audience_users(p_audience varchar, p_countries text[])
RETURNS TABLE (portal_user_id uuid) AS $$
  SELECT u.id
    FROM portal_users u
   WHERE u.is_active = true
     AND CASE p_audience
       WHEN 'everyone'  THEN true
       WHEN 'consumers' THEN u.consumer_id IS NOT NULL
       WHEN 'donors'    THEN u.donor_account_id IS NOT NULL
       WHEN 'villagers' THEN COALESCE(u.donor_type, 'villager') = 'villager'
       WHEN 'overseas'  THEN u.donor_type = 'overseas'
                             AND (cardinality(COALESCE(p_countries, '{}')) = 0
                                  OR u.country = ANY (COALESCE(p_countries, '{}')))
       ELSE false
     END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION appeal_audience_users(varchar, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION appeal_audience_users(varchar, text[]) TO authenticated;

-- Lets the compose screen say "this will reach 34 people" before sending,
-- which is the difference between a considered broadcast and a guess.
CREATE OR REPLACE FUNCTION appeal_audience_count(p_audience varchar, p_countries text[] DEFAULT '{}')
RETURNS int AS $$
  SELECT count(*)::int FROM appeal_audience_users(p_audience, p_countries);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION appeal_audience_count(varchar, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION appeal_audience_count(varchar, text[]) TO authenticated;

-- create_appeal gains p_notify. Defaulted true, because an appeal nobody is
-- told about is a poster in an empty room — but it is a parameter rather than
-- a certainty, since a long-running fundraising appeal should sit in the
-- banner without pinging everyone each time it is edited.
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
  p_expires_at timestamptz DEFAULT NULL,
  p_notify boolean DEFAULT true
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

  IF p_is_public THEN
    INSERT INTO news_ticker (message, message_ur, is_active, display_order)
    VALUES (trim(p_body_en), trim(p_body_ur), true, -100)
    RETURNING id INTO v_ticker;
    UPDATE appeals SET ticker_id = v_ticker WHERE id = v_id;
  END IF;

  -- Urdu first in the body: the banner shows both, but a notification is read
  -- at a glance and most of these people read Urdu.
  IF p_notify THEN
    INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
    SELECT a.portal_user_id, 'appeal',
           COALESCE(nullif(trim(coalesce(p_title_ur, '')), ''),
                    nullif(trim(coalesce(p_title_en, '')), ''),
                    'ایک اپیل'),
           trim(p_body_ur) || chr(10) || trim(p_body_en),
           '/portal'
      FROM appeal_audience_users(p_audience, p_audience_countries) a;
  END IF;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz, boolean) TO authenticated;

-- The 12-argument version from migration 195 would otherwise remain as a second
-- candidate and make every call with defaulted arguments ambiguous.
DROP FUNCTION IF EXISTS create_appeal(varchar, text, text, varchar, text[], boolean, varchar, varchar, varchar, varchar, uuid, timestamptz);

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('appeal', 'The committee posts an appeal aimed at you', false, true)
ON CONFLICT (event_type) DO NOTHING;
