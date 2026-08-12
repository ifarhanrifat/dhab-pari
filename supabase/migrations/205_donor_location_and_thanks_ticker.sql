-- Migration 205: say where a donor is from, and thank them on the news belt.
--
-- ── Where a donor lives ──────────────────────────────────────────────────
-- donor_type was villager-or-overseas, which leaves out most of the people who
-- actually give: villagers who moved to Lahore, Rawalpindi or Karachi and still
-- support the place they came from. They are neither living in the village nor
-- abroad, and calling them either is wrong in a thank-you posted for the whole
-- village to read.
ALTER TABLE donors DROP CONSTRAINT IF EXISTS donors_donor_type_check;
ALTER TABLE donors ADD CONSTRAINT donors_donor_type_check
  CHECK (donor_type IN ('villager', 'city', 'overseas'));

ALTER TABLE donors
  -- The city for 'city', the country for 'overseas'. One column, because it
  -- answers one question — where to say they are from.
  ADD COLUMN IF NOT EXISTS donor_location varchar;

ALTER TABLE portal_users DROP CONSTRAINT IF EXISTS portal_users_donor_type_check;
ALTER TABLE portal_users ADD CONSTRAINT portal_users_donor_type_check
  CHECK (donor_type IN ('villager', 'city', 'overseas'));

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS city varchar;

-- ── The news belt needs to forget things ─────────────────────────────────
-- A thank-you is news for a day. Without an expiry it sits in the ticker for
-- ever and the belt slowly fills with old gratitude until nobody reads any of
-- it.
ALTER TABLE news_ticker
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS news_ticker_live_idx
  ON news_ticker(is_active, expires_at) WHERE is_active;

-- ── Wording lives in Settings, not in the code ───────────────────────────
-- %%who%% resolves to a name with where they are from, or to the anonymous
-- phrasing. %%project%% and %%amount%% are self-explanatory. A committee that
-- would rather not publish amounts simply removes %%amount%% from the template
-- and nothing breaks.
INSERT INTO site_settings (key, value) VALUES
  ('donation_thanks_enabled', 'true'),
  ('donation_thanks_hours', '24'),
  ('donation_thanks_ur',
   '%%who%% نے %%project%% کے لیے %%amount%% روپے کا عطیہ دیا ہے۔ جزاک اللہ خیر — کمیٹی و اہلیانِ ڈھاب پڑی'),
  ('donation_thanks_en',
   '%%who%% has donated Rs. %%amount%% for %%project%%. Jazak Allah Khair — from the Committee and the people of Dhab Pari'),
  -- Kept separate so the anonymous wording can be softened without touching
  -- the sentence around it.
  ('donation_anon_ur', 'ایک نام نہ ظاہر کرنے والے مخیر'),
  ('donation_anon_en', 'A donor who wished to remain anonymous')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION setting_text(p_key varchar, p_fallback text DEFAULT '')
RETURNS text AS $$
  SELECT COALESCE(nullif(trim((SELECT value FROM site_settings WHERE key = p_key)), ''), p_fallback);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- "Ahmad Ali (Lahore se)" / "Ahmad Ali (from Lahore)", or the anonymous phrase.
-- Anonymity is decided by is_anonymous alone — never inferred — so a donor who
-- asked to stay unnamed cannot be named by a later code path that forgot.
CREATE OR REPLACE FUNCTION donation_thanks_who(p_donor_id uuid, p_lang text)
RETURNS text AS $$
DECLARE d donors%ROWTYPE; v_name text; v_where text;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id;
  IF d.id IS NULL THEN RETURN NULL; END IF;

  IF d.is_anonymous THEN
    RETURN CASE WHEN p_lang = 'ur'
      THEN setting_text('donation_anon_ur', 'ایک نام نہ ظاہر کرنے والے مخیر')
      ELSE setting_text('donation_anon_en', 'A donor who wished to remain anonymous') END;
  END IF;

  v_name := CASE WHEN p_lang = 'ur' THEN COALESCE(nullif(trim(d.name_ur), ''), d.name) ELSE d.name END;

  v_where := CASE d.donor_type
    WHEN 'villager' THEN NULL                      -- from here; saying so adds nothing
    WHEN 'city'     THEN nullif(trim(d.donor_location), '')
    WHEN 'overseas' THEN nullif(trim(d.donor_location), '')
    ELSE NULL
  END;

  IF v_where IS NULL THEN RETURN v_name; END IF;
  RETURN CASE WHEN p_lang = 'ur'
    THEN v_name || ' (' || v_where || ' سے)'
    ELSE v_name || ' (from ' || v_where || ')' END;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION donation_thanks_text(p_donor_id uuid, p_lang text)
RETURNS text AS $$
DECLARE
  d donors%ROWTYPE; v_project text; v_tpl text;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id;
  IF d.id IS NULL THEN RETURN NULL; END IF;

  SELECT CASE WHEN p_lang = 'ur' THEN COALESCE(nullif(trim(title_ur), ''), title) ELSE title END
    INTO v_project FROM projects WHERE id = d.project_id;
  v_project := COALESCE(v_project,
    CASE WHEN p_lang = 'ur' THEN 'جنرل فنڈ' ELSE 'the General Fund' END);

  v_tpl := CASE WHEN p_lang = 'ur'
    THEN setting_text('donation_thanks_ur', '%%who%% نے %%project%% کے لیے %%amount%% روپے کا عطیہ دیا ہے۔ جزاک اللہ خیر')
    ELSE setting_text('donation_thanks_en', '%%who%% has donated Rs. %%amount%% for %%project%%. Jazak Allah Khair') END;

  v_tpl := replace(v_tpl, '%%who%%', COALESCE(donation_thanks_who(p_donor_id, p_lang), ''));
  v_tpl := replace(v_tpl, '%%project%%', v_project);
  v_tpl := replace(v_tpl, '%%amount%%', trim(to_char(d.amount_pkr, 'FM999,999,999,990')));
  RETURN v_tpl;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION donation_thanks_text(uuid, text) TO authenticated;

-- Posted the moment a donation is confirmed, and only then: an unconfirmed
-- pledge is money the committee does not yet hold, and thanking someone for it
-- publicly would be both wrong and awkward to retract.
CREATE OR REPLACE FUNCTION trg_donation_thanks_ticker() RETURNS trigger AS $$
DECLARE v_id uuid; v_hours int;
BEGIN
  IF setting_text('donation_thanks_enabled', 'true') <> 'true' THEN RETURN NEW; END IF;
  IF NEW.is_verified IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_verified IS TRUE THEN RETURN NEW; END IF;

  v_hours := COALESCE(nullif(setting_text('donation_thanks_hours', '24'), '')::int, 24);

  -- display_order 0: below an emergency appeal (-100) and above routine
  -- notices, which start at 1.
  INSERT INTO news_ticker (message, message_ur, is_active, display_order, expires_at)
  VALUES (
    donation_thanks_text(NEW.id, 'en'),
    donation_thanks_text(NEW.id, 'ur'),
    true, 0, now() + make_interval(hours => v_hours)
  ) RETURNING id INTO v_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS donation_thanks_ticker ON donors;
CREATE TRIGGER donation_thanks_ticker
  AFTER INSERT OR UPDATE OF is_verified ON donors
  FOR EACH ROW EXECUTE FUNCTION trg_donation_thanks_ticker();

-- Sweeps expired thanks off the belt. Called by the appeal sync job and by the
-- announcement bar, so it works whether or not pg_cron is available.
CREATE OR REPLACE FUNCTION expire_ticker_messages() RETURNS void AS $$
  UPDATE news_ticker SET is_active = false
   WHERE is_active AND expires_at IS NOT NULL AND expires_at <= now();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION expire_ticker_messages() TO anon, authenticated;

CREATE OR REPLACE FUNCTION sync_appeal_tickers() RETURNS void AS $$
  UPDATE news_ticker t SET is_active = true
    FROM appeals a
   WHERE a.ticker_id = t.id AND a.status = 'active' AND a.is_public
     AND a.starts_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())
     AND t.is_active = false;

  UPDATE news_ticker t SET is_active = false
    FROM appeals a
   WHERE a.ticker_id = t.id AND t.is_active = true
     AND (a.status <> 'active' OR a.starts_at > now()
          OR (a.expires_at IS NOT NULL AND a.expires_at <= now()));

  UPDATE news_ticker SET is_active = false
   WHERE is_active AND expires_at IS NOT NULL AND expires_at <= now();
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;
