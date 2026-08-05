-- Migration 101: Employee HR/payroll roster — plumbers, water well operators,
-- night security guards, and (new) valve operators. These are payroll staff,
-- not system logins (unlike admin_users) — closer in shape to committee_members
-- (a public roster) than to a real authenticated account, but this one feeds
-- the accounting system: monthly fixed salary, Eid bonus, overtime, and
-- emergency-work cash payments all post as ordinary approval-gated expense
-- vouchers, reusing the existing trg_voucher_before_insert/voucher_requires_approval
-- pipeline verbatim — no new voucher_type, no new ledger-posting logic.
--
-- Two roles max per employee, mirroring admin_users' own role/secondary_role
-- convention (migration 066) rather than an open-ended array.
--
-- Water-supply only, matching migration 068's explicit precedent (plumbers/
-- guards/connection charges have no donors_projects equivalent).

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  phone varchar,
  cnic varchar,
  primary_role varchar NOT NULL CHECK (primary_role IN ('plumber', 'water_well_operator', 'night_security_guard', 'valve_operator')),
  secondary_role varchar CHECK (secondary_role IS NULL OR (
    secondary_role IN ('plumber', 'water_well_operator', 'night_security_guard', 'valve_operator')
    AND secondary_role IS DISTINCT FROM primary_role
  )),
  monthly_salary decimal NOT NULL DEFAULT 0 CHECK (monthly_salary >= 0),
  is_active boolean NOT NULL DEFAULT true,
  salary_schedule_id uuid REFERENCES recurring_schedules(id),
  created_by uuid REFERENCES admin_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employees_role_idx ON employees(primary_role, secondary_role) WHERE is_active = true;

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "employees_read" ON employees FOR SELECT TO authenticated
  USING (can_access_system('water_supply'));
CREATE POLICY "employees_write" ON employees FOR INSERT TO authenticated
  WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));
CREATE POLICY "employees_update" ON employees FOR UPDATE TO authenticated
  USING (can_access_system('water_supply')) WITH CHECK (can_access_system('water_supply') AND current_admin_permission('manage_parties'));
CREATE POLICY "employees_delete" ON employees FOR DELETE TO authenticated
  USING (can_access_system('water_supply') AND current_admin_permission('manage_parties'));

-- Traceability on payroll vouchers — same idiom as vouchers.consumer_id.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id);

-- Links the auto-created monthly-salary schedule back to its employee so
-- editing the salary or deactivating the employee can keep the schedule in sync.
ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES employees(id) ON DELETE SET NULL;

-- One expense account per payroll payment kind, same reasoning as Discount
-- Given/WS-3008, Discount on Sale/WS-3009, Complaint Bill Waivers/WS-3010 —
-- distinct P&L visibility instead of everything landing in one bucket.
-- Monthly salary keeps using the existing WS-3001 'Salaries & Wages'.
INSERT INTO accounts (code, name, type, system, description, is_protected) VALUES
  ('WS-3011', 'Eid Bonus', 'expense', 'water_supply', 'Eid bonus paid to employees', true),
  ('WS-3012', 'Overtime Payment', 'expense', 'water_supply', 'Overtime wages paid to employees', true),
  ('WS-3013', 'Emergency Work Payment', 'expense', 'water_supply', 'Cash paid on the spot to an employee for emergency/unplanned work', true)
ON CONFLICT (code, system) DO NOTHING;

-- Optional structured link from a new-connection job's plumber/digging charge
-- to the staff member who actually did it — the existing assignee_name/
-- assignee_phone free-text fields (migration 070) stay as-is for backward
-- compatibility and for cases where the work wasn't done by a payroll employee.
ALTER TABLE connection_requests ADD COLUMN IF NOT EXISTS assignee_employee_id uuid REFERENCES employees(id);

-- Hiring Request document text blocks — reuses the existing admin-editable
-- message_templates system (migration 076) instead of a new template table.
-- No %%placeholder%% substitution needed; these are static per-role bodies,
-- edited directly on the Employees page's "Generate Hiring Request" section
-- (and, incidentally, also visible/editable from Settings > Message Templates
-- like any other template row).
INSERT INTO message_templates (key, label, body) VALUES
  ('hiring_plumber_requirements', 'Hiring Request — Plumber — Requirements',
   'امیدوار کی عمر 20 سے 45 سال کے درمیان ہو۔ پلمبنگ کے کام کا کم از کم دو سال کا عملی تجربہ لازمی ہے۔ امیدوار جسمانی طور پر تندرست ہو اور دیہات کے مختلف علاقوں میں آنے جانے کے لیے تیار ہو۔ مقامی رہائشی کو ترجیح دی جائے گی۔'),
  ('hiring_plumber_procedure', 'Hiring Request — Plumber — Working Procedure',
   'پلمبر کمیٹی کی جانب سے موصول ہونے والی شکایات اور نئے کنکشن کی درخواستوں پر انچارج کی ہدایت کے مطابق فوری کارروائی کرے گا۔ ہر کام مکمل کرنے کے بعد اس کی رپورٹ دفتر میں جمع کروانا لازمی ہوگا۔ ہنگامی صورتحال (مثلاً پائپ لائن پھٹنا) میں فوری طور پر موقع پر پہنچنا ضروری ہے۔'),
  ('hiring_plumber_skills', 'Hiring Request — Plumber — Technical Skills',
   'پانی کی پائپ لائن بچھانے، جوڑنے اور مرمت کرنے کی مہارت۔ واٹر میٹر اور والو کی تنصیب و مرمت کا علم۔ بنیادی اوزاروں (رینچ، کٹر، ویلڈنگ مشین وغیرہ) کے استعمال میں مہارت۔'),

  ('hiring_water_well_operator_requirements', 'Hiring Request — Water Well Operator — Requirements',
   'امیدوار کی عمر 22 سے 50 سال کے درمیان ہو۔ موٹر اور جنریٹر چلانے کا تجربہ ضروری ہے۔ امیدوار ذمہ دار، وقت کا پابند اور کمیٹی کی ہدایات پر عمل کرنے والا ہو۔'),
  ('hiring_water_well_operator_procedure', 'Hiring Request — Water Well Operator — Working Procedure',
   'آپریٹر مقررہ اوقات کے مطابق واٹر ویل کی موٹر آن اور آف کرے گا تاکہ تمام سیکٹرز کو باری باری پانی کی فراہمی یقینی بنائی جا سکے۔ موٹر، جنریٹر اور بجلی کے میٹر کی روزانہ نگرانی اور کسی بھی خرابی کی فوری اطلاع انچارج کو دینا لازمی ہوگا۔'),
  ('hiring_water_well_operator_skills', 'Hiring Request — Water Well Operator — Technical Skills',
   'موٹر اور پمپ کے آپریشن کا تکنیکی علم۔ بنیادی برقی خرابیوں کی نشاندہی کرنے کی صلاحیت۔ جنریٹر اور بجلی کے بلا تعطل نظام کی سمجھ بوجھ۔'),

  ('hiring_night_security_guard_requirements', 'Hiring Request — Night Security Guard — Requirements',
   'امیدوار کی عمر 25 سے 55 سال کے درمیان ہو۔ امیدوار جسمانی طور پر تندرست اور رات بھر بیدار رہنے کے قابل ہو۔ کسی بھی مجرمانہ ریکارڈ کا حامل نہ ہو۔ مقامی اور قابل اعتماد شخص کو ترجیح دی جائے گی۔'),
  ('hiring_night_security_guard_procedure', 'Hiring Request — Night Security Guard — Working Procedure',
   'گارڈ رات کے مقررہ اوقات میں کمیٹی کی تنصیبات (موٹر، جنریٹر، ٹینک وغیرہ) کی نگرانی کرے گا۔ کسی بھی مشکوک سرگرمی، چوری یا خرابی کی صورت میں فوری طور پر انچارج کو مطلع کرنا لازمی ہوگا۔'),
  ('hiring_night_security_guard_skills', 'Hiring Request — Night Security Guard — Technical Skills',
   'چوکسی اور نگرانی کی صلاحیت۔ ہنگامی صورتحال میں فوری فیصلہ کرنے کی اہلیت۔ بنیادی مواصلاتی آلات (موبائل فون وغیرہ) کے استعمال سے واقفیت۔'),

  ('hiring_valve_operator_requirements', 'Hiring Request — Valve Operator — Requirements',
   'امیدوار کی عمر 20 سے 50 سال کے درمیان ہو۔ گاؤں کے مختلف سیکٹرز اور پانی کی تقسیم کے نظام سے واقفیت ضروری ہے۔ امیدوار ذمہ دار اور وقت کا پابند ہو۔'),
  ('hiring_valve_operator_procedure', 'Hiring Request — Valve Operator — Working Procedure',
   'والو آپریٹر مقررہ شیڈول کے مطابق مختلف سیکٹرز کے والو کھولے گا اور بند کرے گا تاکہ ہر علاقے کو منصفانہ اور باری باری پانی کی فراہمی ممکن ہو سکے۔ تقسیم کے دوران کسی رکاوٹ یا لیکیج کی صورت میں فوری اطلاع دینا لازمی ہوگا۔'),
  ('hiring_valve_operator_skills', 'Hiring Request — Valve Operator — Technical Skills',
   'پانی کی تقسیم کے نظام اور والو کے آپریشن کی مکمل سمجھ بوجھ۔ سیکٹر وار شیڈول کو درست طریقے سے نافذ کرنے کی صلاحیت۔ بنیادی مرمت کے اوزاروں کا استعمال۔')
ON CONFLICT (key) DO NOTHING;
