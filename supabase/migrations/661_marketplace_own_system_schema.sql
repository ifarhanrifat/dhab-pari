-- Migration 661: Marketplace becomes its own accounting system (Phase 0,
-- part 1 of 2 — schema, chart of accounts, permissions). Everything
-- marketplace-related (vehicle/shop wallets, commission income, shadi
-- advance liability) has lived under system='donors_projects' since
-- migration 388 — meaning a driver's wallet top-up cash has been posting
-- into the exact same DP-1001/DP-1002 cash/bank accounts as every donor
-- donation and water bill payment. Confirmed live before writing this:
-- the one real DP-4050 (commission) account has only 2 ledger_entries
-- ever posted against it, and DP-5004 (shadi advance liability) has 0 —
-- a green-field reclassification, not a restatement of closed books.
-- Part 2 (a separate migration) redefines the ~17 RPCs that look these
-- account codes up by literal string.
--
-- Deliberately NOT done here: threading a third branch through the
-- existing water_supply/donors_projects finance UI engine
-- (finance/[system]/page.tsx, accounts/page.tsx, reports/page.tsx — a
-- combined ~4950 lines hardcoded to exactly two literal SystemTab
-- values). Marketplace gets its own small, purpose-built admin pages in
-- a later pass instead — this migration is schema/permissions only.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Widen the 3 money-relevant CHECK constraints. The other ~12 tables
--    carrying the same water_supply/donors_projects dichotomy
--    (complaints, suggestions, recurring_schedules, connection_templates,
--    approval_*, monthly_closing_reports, etc.) are water/donor-specific
--    features with no marketplace equivalent and stay exactly as they
--    are — monthly_closing_reports gets its own marketplace-shaped
--    table below instead of a third branch (it's built entirely around
--    bills/connections/receivables, which marketplace has none of).
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE accounts DROP CONSTRAINT accounts_system_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_system_check CHECK (system IN ('water_supply', 'donors_projects', 'marketplace'));

ALTER TABLE account_headers DROP CONSTRAINT account_headers_system_check;
ALTER TABLE account_headers ADD CONSTRAINT account_headers_system_check CHECK (system IN ('water_supply', 'donors_projects', 'marketplace'));

ALTER TABLE vouchers DROP CONSTRAINT vouchers_system_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_system_check CHECK (system IN ('water_supply', 'donors_projects', 'marketplace'));

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Permission flag — same shape as access_water_supply/
--    access_donors_projects, per the user's explicit choice: existing
--    admin_users gain a flag, not a separate login/account system.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS access_marketplace boolean NOT NULL DEFAULT false;

-- role_grants_system()'s parameter list is widened by one — CREATE OR
-- REPLACE cannot change it, so DROP first (the same trap migration 202's
-- own comment names for a RETURNS TABLE change; here it's the input list).
DROP FUNCTION IF EXISTS role_grants_system(varchar, varchar, boolean, boolean, varchar);
CREATE OR REPLACE FUNCTION role_grants_system(
  p_role varchar, p_secondary_role varchar, p_access_water boolean, p_access_donors boolean, p_access_marketplace boolean, p_system varchar
) RETURNS boolean AS $$
  SELECT CASE
    -- Full administrators are not scoped; scoping them would lock the only
    -- people who can fix a scoping mistake out of fixing it.
    WHEN p_role IN ('super_admin', 'admin')
      OR p_secondary_role IN ('super_admin', 'admin') THEN true
    ELSE (p_system = 'water_supply'    AND COALESCE(p_access_water, false))
      OR (p_system = 'donors_projects' AND COALESCE(p_access_donors, false))
      OR (p_system = 'marketplace'     AND COALESCE(p_access_marketplace, false))
  END;
$$ LANGUAGE sql IMMUTABLE;
GRANT EXECUTE ON FUNCTION role_grants_system(varchar, varchar, boolean, boolean, boolean, varchar) TO authenticated;

-- can_access_system() reproduced from its real, current body (pulled live
-- via pg_get_functiondef, same discipline migration 592's own comment
-- describes) with only the new 5th argument threaded through — the
-- per-tenant module-flag and billing/subscription gates below are
-- untouched, and p_system = 'marketplace' falls through their own
-- `ELSE true` / default branches exactly as it already did before this
-- migration (marketplace isn't plan-gated per tenant yet — a separate,
-- later decision, not part of this foundational split).
CREATE OR REPLACE FUNCTION can_access_system(p_system varchar) RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT role_grants_system(role, secondary_role, access_water_supply, access_donors_projects, access_marketplace, p_system)
       FROM admin_users WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1),
    false
  )
  AND COALESCE(
    (SELECT CASE p_system
       WHEN 'water_supply' THEN t.water_supply_enabled
       WHEN 'donors_projects' THEN t.donors_enabled
       ELSE true
     END
     FROM admin_users au JOIN tenants t ON t.id = au.tenant_id
     WHERE au.auth_user_id = auth.uid() AND au.is_active = true LIMIT 1),
    false
  )
  AND COALESCE(
    (SELECT t.billing_exempt OR EXISTS (
       SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('trialing', 'active', 'past_due')
     )
     FROM admin_users au JOIN tenants t ON t.id = au.tenant_id
     WHERE au.auth_user_id = auth.uid() AND au.is_active = true LIMIT 1),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION can_access_system(varchar) TO authenticated;

-- system_access_for() — the "what can this user reach" admin audit
-- helper (migration 202) — gains a can_marketplace column, same DROP
-- requirement (RETURNS TABLE row type can't be CREATE OR REPLACE'd).
DROP FUNCTION IF EXISTS system_access_for(uuid);
CREATE OR REPLACE FUNCTION system_access_for(p_admin_user_id uuid)
RETURNS TABLE (full_name text, role text, secondary_role text,
               can_water boolean, can_donors boolean, can_marketplace boolean,
               publish_news boolean, publish_videos boolean, publish_gallery boolean,
               publish_ticker boolean, publish_jobs boolean, publish_poetry boolean, publish_blog boolean) AS $$
  SELECT u.full_name::text, u.role::text, u.secondary_role::text,
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, u.access_marketplace, 'water_supply'),
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, u.access_marketplace, 'donors_projects'),
         role_grants_system(u.role, u.secondary_role, u.access_water_supply, u.access_donors_projects, u.access_marketplace, 'marketplace'),
         u.can_publish_news, u.can_publish_videos, u.can_publish_gallery,
         u.can_publish_ticker, u.can_publish_jobs, u.can_publish_poetry, u.can_publish_blog
    FROM admin_users u
   WHERE u.id = p_admin_user_id
     AND EXISTS (SELECT 1 FROM admin_users a
                  WHERE a.auth_user_id = auth.uid() AND a.is_active = true
                    AND a.role IN ('super_admin', 'admin'))
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
GRANT EXECUTE ON FUNCTION system_access_for(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Build the marketplace chart of accounts for every existing tenant,
--    THEN move the real accounts onto it. Order matters here:
--    accounts_type_fkey (migration 613) requires a matching
--    account_headers(tenant_id, system, code) row to exist for
--    accounts(tenant_id, system, type) at all times — so the headers for
--    every type a marketplace account can have (cash/bank/income/
--    liability/shop/vehicle_owner) must be inserted before any account
--    is moved onto system='marketplace', not after. The old
--    donors_projects 'shop'/'vehicle_owner' headers are left in place,
--    now with zero accounts under them — harmless, simpler than
--    reclassifying them in place under the same FK ordering constraint.
-- ═════════════════════════════════════════════════════════════════════════
INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system)
SELECT t.id, 'marketplace', h.code, h.label, h.label_ur, h.code_prefix, h.display_order, true
FROM tenants t
CROSS JOIN (VALUES
  ('cash', 'Cash-in-hand', 'نقد', 'MKT-CSH', 1),
  ('bank', 'Bank A/Cs', NULL, 'MKT-BNK', 2),
  ('income', 'Income', 'آمدنی', 'MKT-INC', 3),
  ('liability', 'Liabilities', NULL, 'MKT-LIA', 6),
  ('shop', 'Shop Owners', NULL, 'MKT-SHP', 11),
  ('vehicle_owner', 'Vehicle Owners', NULL, 'MKT-VEH', 12)
) AS h(code, label, label_ur, code_prefix, display_order)
WHERE NOT EXISTS (SELECT 1 FROM account_headers eh WHERE eh.tenant_id = t.id AND eh.system = 'marketplace' AND eh.code = h.code);

-- Reclassify the marketplace accounts that already exist, in place —
-- same row ids, so the 2 real ledger_entries against DP-4050 keep
-- resolving correctly with zero data migration.
UPDATE accounts SET system = 'marketplace', code = 'MKT-4050'
WHERE system = 'donors_projects' AND code = 'DP-4050';

UPDATE accounts SET system = 'marketplace', code = 'MKT-5004'
WHERE system = 'donors_projects' AND code = 'DP-5004';

UPDATE accounts SET system = 'marketplace'
WHERE system = 'donors_projects' AND (vehicle_id IS NOT NULL OR shop_id IS NOT NULL);

-- New marketplace cash/bank accounts — one pair per tenant, mirroring
-- DP-1001/DP-1002's own shape exactly, so marketplace wallet top-up cash
-- stops landing in the shared donor/water cash-in-hand accounts.
INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, payment_channel, is_protected)
SELECT t.id, 'MKT-1001', 'Cash in Hand', 'نقد رقم', 'cash', 'marketplace', 'Cash collected for marketplace wallet top-ups (vehicle/shop)', 'cash', true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.system = 'marketplace' AND a.code = 'MKT-1001');

INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, payment_channel, is_protected)
SELECT t.id, 'MKT-1002', 'Bank / Mobile Wallet', 'بینک / موبائل والٹ', 'bank', 'marketplace', 'Bank/mobile-wallet top-ups for marketplace wallets (vehicle/shop)', 'bank', true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.system = 'marketplace' AND a.code = 'MKT-1002');

-- A tenant with vehicles/shops but no DP-4050/DP-5004 yet (neither
-- currently exists for the two non-dhab-pari tenants — confirmed live,
-- they have zero marketplace activity so far) still needs the accounts
-- in place before their first booking.
INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, is_protected)
SELECT t.id, 'MKT-4050', 'Marketplace Commission Income', 'مارکیٹ پلیس کمیشن آمدنی', 'income', 'marketplace',
  'The committee''s cut of every confirmed shop order and vehicle booking', true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.system = 'marketplace' AND a.code = 'MKT-4050');

INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, is_protected)
SELECT t.id, 'MKT-5004', 'Shadi Advances Payable to Vehicles', 'شادی گاڑی ایڈوانس واجب الادا', 'liability', 'marketplace',
  'Shadi booking advances collected and held on behalf of vehicles until the wedding date', true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.tenant_id = t.id AND a.system = 'marketplace' AND a.code = 'MKT-5004');

-- ═════════════════════════════════════════════════════════════════════════
-- 4. seed_default_chart_of_accounts() — reproduced from its real, current
--    body (migration 633) with a new, unconditional marketplace block
--    added (same two params, no signature change, no caller update
--    needed) so a tenant created after this migration is provisioned
--    with its own marketplace chart of accounts from day one, instead of
--    hitting the latent "no DP-4050 for this tenant yet" gap the two
--    real non-dhab-pari tenants are in right now (fixed above for them;
--    this is the forward-looking half of that same fix). Not gated by
--    a plan flag — marketplace access isn't tenant-plan-gated yet,
--    matching can_access_system()'s own `ELSE true` default above.
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION seed_default_chart_of_accounts(
  p_tenant_id uuid,
  p_water_supply boolean,
  p_donors_projects boolean
) RETURNS void AS $$
BEGIN
  IF p_water_supply THEN
    INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
      (p_tenant_id, 'water_supply', 'consumer',  'Consumers',         'صارفین',        'WS-CON', 0, true),
      (p_tenant_id, 'water_supply', 'cash',      'Cash-in-hand',      'نقد',           'WS-CSH', 1, true),
      (p_tenant_id, 'water_supply', 'bank',      'Bank A/Cs',         'بینک اکاؤنٹس',  'WS-BNK', 2, true),
      (p_tenant_id, 'water_supply', 'income',    'Income',            'آمدنی',         'WS-INC', 3, true),
      (p_tenant_id, 'water_supply', 'expense',   'Expenses',          'اخراجات',       'WS-EXP', 4, true),
      (p_tenant_id, 'water_supply', 'asset',     'Assets',            'اثاثے',         'WS-AST', 5, true),
      (p_tenant_id, 'water_supply', 'liability', 'Liabilities',       'ذمہ داریاں',    'WS-LIA', 6, true),
      (p_tenant_id, 'water_supply', 'collector', 'Field Collectors',  NULL,            'WS-COL', 7, true),
      (p_tenant_id, 'water_supply', 'employee',  'Employees Payable', NULL,            'WS-EMP', 8, true)
    ON CONFLICT (tenant_id, system, code) DO NOTHING;

    INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description) VALUES
      (p_tenant_id, 'WS-1001', 'Cash in Hand',         'نقد رقم',       'cash',    'water_supply', 'Physical cash held by water supply accountant'),
      (p_tenant_id, 'WS-1002', 'Bank Account',         'بینک اکاؤنٹ',   'bank',    'water_supply', 'Bank account for water supply funds'),
      (p_tenant_id, 'WS-2001', 'Water Bill Income',    'بل وصولی',      'income',  'water_supply', 'Monthly water bill collections'),
      (p_tenant_id, 'WS-2002', 'Connection Fee',       'کنکشن فیس',     'income',  'water_supply', 'New connection fee income'),
      (p_tenant_id, 'WS-3001', 'Salaries & Wages',     'تنخواہیں',      'expense', 'water_supply', 'Staff salaries and daily wages'),
      (p_tenant_id, 'WS-3002', 'Electricity Bill',     'بجلی بل',       'expense', 'water_supply', 'Electricity for pumps and office'),
      (p_tenant_id, 'WS-3003', 'Repair & Maintenance', 'مرمت',          'expense', 'water_supply', 'Pipeline, pump and infrastructure repairs'),
      (p_tenant_id, 'WS-3004', 'Chemical Treatment',   'کیمیکل',        'expense', 'water_supply', 'Water purification chemicals'),
      (p_tenant_id, 'WS-3005', 'Fuel Expense',         'ایندھن',        'expense', 'water_supply', 'Generator and vehicle fuel'),
      (p_tenant_id, 'WS-3006', 'Office Expense',       'دفتری اخراجات', 'expense', 'water_supply', 'Stationery and office supplies'),
      (p_tenant_id, 'WS-4001', 'Equipment & Assets',   'اثاثے',         'asset',   'water_supply', 'Pumps, tools and equipment inventory'),
      (p_tenant_id, 'WS-5001', 'Loan Payable',         'قرض',           'liability', 'water_supply', 'Outstanding loans or payables')
    ON CONFLICT (tenant_id, code, system) DO NOTHING;
  END IF;

  IF p_donors_projects THEN
    INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
      (p_tenant_id, 'donors_projects', 'donor',          'Donors',                 'عطیہ دہندگان',  'DP-DNR', 0,  true),
      (p_tenant_id, 'donors_projects', 'cash',           'Cash-in-hand',           'نقد',           'DP-CSH', 1,  true),
      (p_tenant_id, 'donors_projects', 'bank',           'Bank A/Cs',              'بینک اکاؤنٹس',  'DP-BNK', 2,  true),
      (p_tenant_id, 'donors_projects', 'income',         'Income',                 'آمدنی',         'DP-INC', 3,  true),
      (p_tenant_id, 'donors_projects', 'expense',        'Expenses',               'اخراجات',       'DP-EXP', 4,  true),
      (p_tenant_id, 'donors_projects', 'asset',          'Assets',                 'اثاثے',         'DP-AST', 5,  true),
      (p_tenant_id, 'donors_projects', 'liability',      'Liabilities',            'ذمہ داریاں',    'DP-LIA', 6,  true),
      (p_tenant_id, 'donors_projects', 'collector',      'Field Collectors',       NULL,            'DP-COL', 7,  true),
      (p_tenant_id, 'donors_projects', 'project',        'Project Funds',          'منصوبہ جات',    'DP-PRJ', 8,  true),
      (p_tenant_id, 'donors_projects', 'restricted_fund','Restricted Funds',       NULL,            'DP-RF',  9,  true),
      (p_tenant_id, 'donors_projects', 'institution',    'Schools & Institutions', 'سکول و ادارے',  'DP-INS', 10, true),
      (p_tenant_id, 'donors_projects', 'student',        'Students Supported',     'زیرِ کفالت طلبہ','DP-STU', 11, true)
    ON CONFLICT (tenant_id, system, code) DO NOTHING;

    INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description) VALUES
      (p_tenant_id, 'DP-1001', 'Cash in Hand',        'نقد رقم',        'cash',      'donors_projects', 'Cash held for donor and project funds'),
      (p_tenant_id, 'DP-1002', 'Bank Account',        'بینک اکاؤنٹ',    'bank',      'donors_projects', 'Bank account for project funds'),
      (p_tenant_id, 'DP-2001', 'Donations Income',    'عطیات',          'income',    'donors_projects', 'All donations and contributions received'),
      (p_tenant_id, 'DP-2002', 'Zakat Income',        'زکوٰۃ',          'income',    'donors_projects', 'Zakat contributions'),
      (p_tenant_id, 'DP-2003', 'Grant Income',        'گرانٹ',          'income',    'donors_projects', 'Government and NGO grants'),
      (p_tenant_id, 'DP-3001', 'Project Expenditure', 'منصوبہ اخراجات', 'expense',   'donors_projects', 'Direct project construction and material costs'),
      (p_tenant_id, 'DP-3002', 'Labour Cost',         'مزدوری',         'expense',   'donors_projects', 'Labour charges for projects'),
      (p_tenant_id, 'DP-3003', 'Administrative Cost', 'انتظامی',        'expense',   'donors_projects', 'Admin and overhead expenses'),
      (p_tenant_id, 'DP-4001', 'Equipment & Assets',  'اثاثے',          'asset',     'donors_projects', 'Purchased equipment and tools'),
      (p_tenant_id, 'DP-5001', 'Loan Payable',        'قرض',            'liability', 'donors_projects', 'Outstanding loans or payables')
    ON CONFLICT (tenant_id, code, system) DO NOTHING;
  END IF;

  -- Marketplace — unconditional (not gated by either flag above; a
  -- tenant adds its first vehicle/shop independently of whether it has
  -- water/donor modules enabled at all).
  INSERT INTO account_headers (tenant_id, system, code, label, label_ur, code_prefix, display_order, is_system) VALUES
    (p_tenant_id, 'marketplace', 'cash',          'Cash-in-hand',   'نقد',  'MKT-CSH', 1,  true),
    (p_tenant_id, 'marketplace', 'bank',          'Bank A/Cs',      NULL,   'MKT-BNK', 2,  true),
    (p_tenant_id, 'marketplace', 'income',        'Income',         'آمدنی', 'MKT-INC', 3, true),
    (p_tenant_id, 'marketplace', 'liability',     'Liabilities',    NULL,   'MKT-LIA', 6,  true),
    (p_tenant_id, 'marketplace', 'shop',          'Shop Owners',    NULL,   'MKT-SHP', 11, true),
    (p_tenant_id, 'marketplace', 'vehicle_owner', 'Vehicle Owners', NULL,   'MKT-VEH', 12, true)
  ON CONFLICT (tenant_id, system, code) DO NOTHING;

  INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, payment_channel, is_protected) VALUES
    (p_tenant_id, 'MKT-1001', 'Cash in Hand', 'نقد رقم', 'cash', 'marketplace', 'Cash collected for marketplace wallet top-ups (vehicle/shop)', 'cash', true),
    (p_tenant_id, 'MKT-1002', 'Bank / Mobile Wallet', 'بینک / موبائل والٹ', 'bank', 'marketplace', 'Bank/mobile-wallet top-ups for marketplace wallets (vehicle/shop)', 'bank', true)
  ON CONFLICT (tenant_id, code, system) DO NOTHING;

  INSERT INTO accounts (tenant_id, code, name, name_ur, type, system, description, is_protected) VALUES
    (p_tenant_id, 'MKT-4050', 'Marketplace Commission Income', 'مارکیٹ پلیس کمیشن آمدنی', 'income', 'marketplace',
      'The committee''s cut of every confirmed shop order and vehicle booking', true),
    (p_tenant_id, 'MKT-5004', 'Shadi Advances Payable to Vehicles', 'شادی گاڑی ایڈوانس واجب الادا', 'liability', 'marketplace',
      'Shadi booking advances collected and held on behalf of vehicles until the wedding date', true)
  ON CONFLICT (tenant_id, code, system) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. New marketplace-shaped settlement/closing table — not a reuse of
--    monthly_closing_reports (built entirely around bills/connections/
--    receivables, which marketplace has none of).
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS marketplace_closing_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid),
  report_month int NOT NULL CHECK (report_month BETWEEN 1 AND 12),
  report_year int NOT NULL,
  commission_income_pkr decimal NOT NULL DEFAULT 0,
  topups_confirmed_pkr decimal NOT NULL DEFAULT 0,
  settlements_paid_pkr decimal NOT NULL DEFAULT 0,
  wallet_balances_outstanding_pkr decimal NOT NULL DEFAULT 0,
  by_service_type jsonb NOT NULL DEFAULT '{}',
  closed_by uuid REFERENCES admin_users(id),
  closed_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, report_month, report_year)
);
ALTER TABLE marketplace_closing_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "marketplace_closing_reports_read" ON marketplace_closing_reports;
CREATE POLICY "marketplace_closing_reports_read" ON marketplace_closing_reports FOR SELECT TO authenticated
  USING (tenant_id = my_tenant_id() AND can_access_system('marketplace'));
DROP POLICY IF EXISTS "marketplace_closing_reports_write" ON marketplace_closing_reports;
CREATE POLICY "marketplace_closing_reports_write" ON marketplace_closing_reports FOR INSERT TO authenticated
  WITH CHECK (tenant_id = my_tenant_id() AND can_access_system('marketplace') AND COALESCE(current_admin_permission('post_transactions'), false));
