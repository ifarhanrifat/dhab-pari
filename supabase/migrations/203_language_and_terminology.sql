-- Migration 203: language preference, editable terminology, and wording
-- overrides. Phase 1 and 2 of making the whole system work in Urdu.
--
-- ── Why three separate mechanisms ────────────────────────────────────────
-- Text in this app is three different things and they need different homes:
--
--   1. Interface wording ("Save", "Outstanding", ~1,700 strings) ships in the
--      code, so a village that buys this gets a fully Urdu system on day one
--      and every feature built later arrives already translated. Putting 1,700
--      rows in a settings screen would make it unusable AND mean anything new
--      shows in English until somebody hand-translates it.
--
--   2. Terminology (voucher types, account types, report column headings) is
--      seeded here and editable, because committees genuinely disagree about
--      the right Urdu word for "voucher" and each should be able to set their
--      own without a code change.
--
--   3. Records (donor names, particulars) already use _ur columns.
--
-- ui_overrides below covers the case where a village dislikes a shipped
-- interface word: it stores only what they changed, so upgrades keep working.

-- ── 1. Whose language ────────────────────────────────────────────────────
-- The village default lives in site_settings.display_language already. This is
-- the per-person override on top of it: a committee can run in Urdu while one
-- member who prefers English is not forced out of their comfort.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS preferred_language varchar
    CHECK (preferred_language IN ('en', 'ur'));

ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS preferred_language varchar
    CHECK (preferred_language IN ('en', 'ur'));

-- NULL means "follow the village default", which is what everyone starts as.

CREATE OR REPLACE FUNCTION my_language() RETURNS text AS $$
  SELECT COALESCE(
    (SELECT preferred_language FROM admin_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT preferred_language FROM portal_users
      WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    (SELECT value FROM site_settings WHERE key = 'display_language'),
    'en'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION my_language() TO anon, authenticated;

CREATE OR REPLACE FUNCTION set_my_language(p_lang varchar) RETURNS void AS $$
BEGIN
  IF p_lang IS NOT NULL AND p_lang NOT IN ('en', 'ur') THEN
    RAISE EXCEPTION 'Language must be en or ur';
  END IF;
  UPDATE admin_users SET preferred_language = p_lang WHERE auth_user_id = auth.uid();
  UPDATE portal_users SET preferred_language = p_lang WHERE auth_user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION set_my_language(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_my_language(varchar) TO authenticated;

-- ── 2. Terminology ───────────────────────────────────────────────────────
-- `code` is what the database stores and every query filters on. label_en and
-- label_ur are only ever displayed.
--
-- This distinction is the whole safety of the feature: if an edit could change
-- `code`, every filter, report and stored row would break silently. A trigger
-- below makes `code` immutable so no screen, however carelessly written, can
-- change it.
CREATE TABLE IF NOT EXISTS term_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category varchar NOT NULL,
  code varchar NOT NULL,
  label_en varchar NOT NULL,
  label_ur varchar NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, code)
);

CREATE OR REPLACE FUNCTION trg_term_labels_code_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION 'A term''s code identifies stored data and cannot be changed — edit its label instead';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS term_labels_code_immutable ON term_labels;
CREATE TRIGGER term_labels_code_immutable BEFORE UPDATE ON term_labels
  FOR EACH ROW EXECUTE FUNCTION trg_term_labels_code_immutable();

ALTER TABLE term_labels ENABLE ROW LEVEL SECURITY;
-- Readable by everyone: a public receipt and the website both need these words.
CREATE POLICY "term_labels_read" ON term_labels FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "term_labels_write" ON term_labels FOR UPDATE TO authenticated
  USING (current_admin_permission('manage_accounts') IS DISTINCT FROM false)
  WITH CHECK (current_admin_permission('manage_accounts') IS DISTINCT FROM false);

-- Seeded from the vocabularies actually present in this database, checked
-- against the CHECK constraints and the live rows rather than guessed.
INSERT INTO term_labels (category, code, label_en, label_ur, sort_order) VALUES
  -- Voucher types (vouchers.voucher_type)
  ('voucher_type', 'expense',            'Expense',            'اخراجات', 1),
  ('voucher_type', 'income',             'Income',             'آمدنی', 2),
  ('voucher_type', 'contra',             'Contra',             'کونٹرا', 3),
  ('voucher_type', 'withdrawal',         'Withdrawal',         'رقم نکلوائی', 4),
  ('voucher_type', 'deposit',            'Deposit',            'رقم جمع', 5),
  ('voucher_type', 'advance',            'Advance',            'پیشگی', 6),
  ('voucher_type', 'advance_settlement', 'Advance Settlement', 'پیشگی کی تصفیہ', 7),
  ('voucher_type', 'security_deposit',   'Security Deposit',   'ضمانتی رقم', 8),

  -- Account types (accounts.type)
  ('account_type', 'cash',      'Cash',      'نقد', 1),
  ('account_type', 'bank',      'Bank',      'بینک', 2),
  ('account_type', 'income',    'Income',    'آمدنی', 3),
  ('account_type', 'expense',   'Expense',   'اخراجات', 4),
  ('account_type', 'asset',     'Asset',     'اثاثہ', 5),
  ('account_type', 'liability', 'Liability', 'واجبات', 6),
  ('account_type', 'consumer',  'Consumer',  'صارف', 7),
  ('account_type', 'donor',     'Donor',     'عطیہ دہندہ', 8),
  ('account_type', 'project',   'Project',   'منصوبہ', 9),
  ('account_type', 'employee',  'Employee',  'ملازم', 10),
  ('account_type', 'collector', 'Collector', 'وصول کنندہ', 11),

  -- Report and ledger column headings
  ('report_column', 'date',        'Date',        'تاریخ', 1),
  ('report_column', 'voucher_no',  'Voucher No',  'واؤچر نمبر', 2),
  ('report_column', 'particular',  'Particulars', 'تفصیل', 3),
  ('report_column', 'account',     'Account',     'اکاؤنٹ', 4),
  ('report_column', 'debit',       'Debit',       'ڈیبٹ', 5),
  ('report_column', 'credit',      'Credit',      'کریڈٹ', 6),
  ('report_column', 'balance',     'Balance',     'بیلنس', 7),
  ('report_column', 'amount',      'Amount',      'رقم', 8),
  ('report_column', 'opening',     'Opening',     'ابتدائی', 9),
  ('report_column', 'closing',     'Closing',     'اختتامی', 10),
  ('report_column', 'total',       'Total',       'کل', 11),
  ('report_column', 'name',        'Name',        'نام', 12),
  ('report_column', 'mobile',      'Mobile',      'موبائل', 13),
  ('report_column', 'sector',      'Sector',      'سیکٹر', 14),
  ('report_column', 'month',       'Month',       'مہینہ', 15),
  ('report_column', 'status',      'Status',      'حالت', 16),
  ('report_column', 'consumer_no', 'Consumer No', 'صارف نمبر', 17),
  ('report_column', 'received_by', 'Received By', 'وصول کنندہ', 18),
  ('report_column', 'paid_to',     'Paid To',     'ادا کنندہ', 19),
  ('report_column', 'discount',    'Discount',    'رعایت', 20),
  ('report_column', 'arrears',     'Arrears',     'بقایا جات', 21),

  -- Statuses
  ('status', 'paid',     'Paid',     'ادا شدہ', 1),
  ('status', 'unpaid',   'Unpaid',   'واجب الادا', 2),
  ('status', 'partial',  'Partial',  'جزوی', 3),
  ('status', 'pending',  'Pending',  'زیرِ التوا', 4),
  ('status', 'late',     'Late',     'تاخیر سے', 5),
  ('status', 'pledged',  'Announced', 'اعلان شدہ', 6),
  ('status', 'active',   'Active',   'فعال', 7),
  ('status', 'inactive', 'Inactive', 'غیر فعال', 8),
  ('status', 'approved', 'Approved', 'منظور شدہ', 9),
  ('status', 'rejected', 'Rejected', 'مسترد', 10),
  ('status', 'cancelled','Cancelled','منسوخ', 11),

  -- The two systems, by name
  ('system', 'water_supply',    'Water Supply',      'واٹر سپلائی', 1),
  ('system', 'donors_projects', 'Donors & Projects', 'عطیات و منصوبہ جات', 2)
ON CONFLICT (category, code) DO NOTHING;

-- ── 3. Interface wording overrides ───────────────────────────────────────
-- Only holds what a village deliberately changed. Everything absent falls back
-- to the dictionary shipped in the code, so a system sold tomorrow is fully
-- Urdu without anyone touching this table.
CREATE TABLE IF NOT EXISTS ui_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  locale varchar NOT NULL CHECK (locale IN ('en', 'ur')),
  key varchar NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (locale, key)
);

ALTER TABLE ui_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ui_overrides_read" ON ui_overrides FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "ui_overrides_write" ON ui_overrides FOR ALL TO authenticated
  USING (current_admin_permission('manage_accounts') IS DISTINCT FROM false)
  WITH CHECK (current_admin_permission('manage_accounts') IS DISTINCT FROM false);

-- One call for everything the interface needs to render in a language, so a
-- page load costs a single round trip rather than three.
CREATE OR REPLACE FUNCTION language_pack()
RETURNS TABLE (language text, terms jsonb, overrides jsonb) AS $$
  SELECT
    my_language(),
    (SELECT COALESCE(jsonb_object_agg(category || '.' || code,
              jsonb_build_object('en', label_en, 'ur', label_ur)), '{}'::jsonb)
       FROM term_labels),
    (SELECT COALESCE(jsonb_object_agg(locale || '.' || key, value), '{}'::jsonb)
       FROM ui_overrides);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION language_pack() TO anon, authenticated;
