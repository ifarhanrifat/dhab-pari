-- Migration 006: Chart of Accounts, partial payments, donor fields, user roles

-- 1. Add partial payment support to bills
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS paid_amount decimal DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description text;

-- Drop old status constraint and add 'partial'
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_status_check
  CHECK (status IN ('paid', 'unpaid', 'pending', 'late', 'partial'));

-- 2. Add phone and donor_type to donors
ALTER TABLE donors
  ADD COLUMN IF NOT EXISTS phone varchar,
  ADD COLUMN IF NOT EXISTS donor_type varchar DEFAULT 'villager'
    CHECK (donor_type IN ('villager', 'overseas'));

-- 3. Chart of accounts (expense accounts, cash accounts, etc.)
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar NOT NULL,
  name varchar NOT NULL,
  name_ur varchar,
  type varchar NOT NULL
    CHECK (type IN ('cash', 'bank', 'expense', 'income', 'asset', 'liability')),
  system varchar NOT NULL DEFAULT 'water_supply'
    CHECK (system IN ('water_supply', 'donors_projects')),
  description text,
  opening_balance decimal DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(code, system)
);

-- 4. Admin user roles table
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar NOT NULL UNIQUE,
  full_name varchar NOT NULL,
  role varchar NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('super_admin', 'water_accountant', 'donor_accountant', 'publisher', 'viewer')),
  is_active boolean DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- 5. RLS for new tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can manage accounts"
  ON accounts FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated can manage admin_users"
  ON admin_users FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 6. Seed default accounts — Water Supply System
INSERT INTO accounts (code, name, name_ur, type, system, description) VALUES
  ('WS-1001', 'Cash in Hand',        'نقد رقم',       'cash',    'water_supply', 'Physical cash held by water supply accountant'),
  ('WS-1002', 'Bank Account',        'بینک اکاؤنٹ',   'bank',    'water_supply', 'Bank account for water supply funds'),
  ('WS-2001', 'Water Bill Income',   'بل وصولی',      'income',  'water_supply', 'Monthly water bill collections'),
  ('WS-2002', 'Connection Fee',      'کنکشن فیس',     'income',  'water_supply', 'New connection fee income'),
  ('WS-3001', 'Salaries & Wages',    'تنخواہیں',      'expense', 'water_supply', 'Staff salaries and daily wages'),
  ('WS-3002', 'Electricity Bill',    'بجلی بل',       'expense', 'water_supply', 'Electricity for pumps and office'),
  ('WS-3003', 'Repair & Maintenance','مرمت',          'expense', 'water_supply', 'Pipeline, pump and infrastructure repairs'),
  ('WS-3004', 'Chemical Treatment',  'کیمیکل',        'expense', 'water_supply', 'Water purification chemicals'),
  ('WS-3005', 'Fuel Expense',        'ایندھن',        'expense', 'water_supply', 'Generator and vehicle fuel'),
  ('WS-3006', 'Office Expense',      'دفتری اخراجات', 'expense', 'water_supply', 'Stationery and office supplies')
ON CONFLICT (code, system) DO NOTHING;

-- 7. Seed default accounts — Donors & Projects System
INSERT INTO accounts (code, name, name_ur, type, system, description) VALUES
  ('DP-1001', 'Cash in Hand',         'نقد رقم',       'cash',      'donors_projects', 'Cash held for donor and project funds'),
  ('DP-1002', 'Bank Account',         'بینک اکاؤنٹ',   'bank',      'donors_projects', 'Bank account for project funds'),
  ('DP-2001', 'Donations Income',     'عطیات',         'income',    'donors_projects', 'All donations and contributions received'),
  ('DP-2002', 'Zakat Income',         'زکوٰۃ',         'income',    'donors_projects', 'Zakat contributions'),
  ('DP-2003', 'Grant Income',         'گرانٹ',         'income',    'donors_projects', 'Government and NGO grants'),
  ('DP-3001', 'Project Expenditure',  'منصوبہ اخراجات','expense',   'donors_projects', 'Direct project construction and material costs'),
  ('DP-3002', 'Labour Cost',          'مزدوری',        'expense',   'donors_projects', 'Labour charges for projects'),
  ('DP-3003', 'Administrative Cost',  'انتظامی',       'expense',   'donors_projects', 'Admin and overhead expenses'),
  ('DP-4001', 'Equipment & Assets',   'اثاثے',         'asset',     'donors_projects', 'Purchased equipment and tools'),
  ('DP-5001', 'Loan Payable',         'قرض',           'liability', 'donors_projects', 'Outstanding loans or payables')
ON CONFLICT (code, system) DO NOTHING;
