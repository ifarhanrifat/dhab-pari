-- ==========================================
-- CONSUMERS (10 entries, various sectors)
-- ==========================================
INSERT INTO consumers (consumer_id, name, name_ur, mobile, address, area, house_no, sector, connection_date, status, monthly_rate) VALUES
('DP-1001', 'Chaudhry Ahmed Ali', 'چوہدری احمد علی', '0300-1234567', 'House #12, Street 3', 'Main Ward', '12', 'Sector A', '2019-03-15', 'active', 200),
('DP-1002', 'Malik Sajid Hussain', 'ملک ساجد حسین', '0312-9876543', 'House #08, Street 1', 'East Ward', '08', 'Sector B', '2019-06-20', 'active', 200),
('DP-1003', 'Haji Muhammad Ibrahim', 'حاجی محمد ابراہیم', '0345-5551234', 'House #44, Main Road', 'West Ward', '44', 'Sector A', '2018-11-01', 'active', 250),
('DP-1004', 'Sheikh Farooq Ahmed', 'شیخ فاروق احمد', '0331-7778899', 'House #22, Street 5', 'North Ward', '22', 'Sector C', '2020-01-10', 'active', 200),
('DP-1005', 'Gulzar Khan', 'گلزار خان', '0300-4443322', 'House #02, Street 2', 'South Ward', '02', 'Sector B', '2019-08-25', 'active', 200),
('DP-1006', 'Muhammad Rasheed', 'محمد رشید', '0315-6667788', 'House #55, Main Market', 'Main Ward', '55', 'Sector A', '2018-06-15', 'active', 300),
('DP-1007', 'Arshad Mehmood', 'ارشد محمود', '0342-1112233', 'House #31, Street 4', 'East Ward', '31', 'Sector C', '2021-02-14', 'active', 200),
('DP-1008', 'Zahoor Ahmed', 'ظہور احمد', '0300-9998877', 'House #17, Street 6', 'West Ward', '17', 'Sector B', '2020-07-03', 'active', 200),
('DP-1009', 'Ghulam Nabi', 'غلام نبی', '0333-5556677', 'House #63, Near Mosque', 'North Ward', '63', 'Sector A', '2018-03-01', 'active', 250),
('DP-1010', 'Tariq Mehmood', 'طارق محمود', '0346-2223344', 'House #09, Street 7', 'South Ward', '09', 'Sector C', '2022-04-18', 'inactive', 200);

-- ==========================================
-- BILLS (last 3 months, mix of statuses)
-- ==========================================
-- April 2024
INSERT INTO bills (consumer_id, month, year, amount_pkr, status, paid_date, payment_method) VALUES
('DP-1001', 4, 2024, 200, 'paid', '2024-04-08', 'jazzcash'),
('DP-1002', 4, 2024, 200, 'paid', '2024-04-10', 'cash'),
('DP-1003', 4, 2024, 250, 'paid', '2024-04-05', 'bank'),
('DP-1004', 4, 2024, 200, 'late', '2024-04-22', 'easypaisa'),
('DP-1005', 4, 2024, 200, 'paid', '2024-04-09', 'cash'),
('DP-1006', 4, 2024, 300, 'paid', '2024-04-03', 'bank'),
('DP-1007', 4, 2024, 200, 'paid', '2024-04-12', 'jazzcash'),
('DP-1008', 4, 2024, 200, 'unpaid', NULL, NULL),
('DP-1009', 4, 2024, 250, 'paid', '2024-04-07', 'cash'),
('DP-1010', 4, 2024, 200, 'unpaid', NULL, NULL);

-- May 2024
INSERT INTO bills (consumer_id, month, year, amount_pkr, status, paid_date, payment_method) VALUES
('DP-1001', 5, 2024, 200, 'paid', '2024-05-06', 'jazzcash'),
('DP-1002', 5, 2024, 200, 'paid', '2024-05-11', 'easypaisa'),
('DP-1003', 5, 2024, 250, 'pending', NULL, NULL),
('DP-1004', 5, 2024, 200, 'unpaid', NULL, NULL),
('DP-1005', 5, 2024, 200, 'paid', '2024-05-08', 'cash'),
('DP-1006', 5, 2024, 300, 'paid', '2024-05-02', 'bank'),
('DP-1007', 5, 2024, 200, 'unpaid', NULL, NULL),
('DP-1008', 5, 2024, 200, 'unpaid', NULL, NULL),
('DP-1009', 5, 2024, 250, 'paid', '2024-05-09', 'cash'),
('DP-1010', 5, 2024, 200, 'unpaid', NULL, NULL);

-- June 2024
INSERT INTO bills (consumer_id, month, year, amount_pkr, status, paid_date, payment_method) VALUES
('DP-1001', 6, 2024, 200, 'paid', '2024-06-05', 'jazzcash'),
('DP-1002', 6, 2024, 200, 'pending', NULL, NULL),
('DP-1003', 6, 2024, 250, 'unpaid', NULL, NULL),
('DP-1004', 6, 2024, 200, 'unpaid', NULL, NULL),
('DP-1005', 6, 2024, 200, 'paid', '2024-06-10', 'easypaisa'),
('DP-1006', 6, 2024, 300, 'paid', '2024-06-01', 'bank'),
('DP-1007', 6, 2024, 200, 'pending', NULL, NULL),
('DP-1008', 6, 2024, 200, 'unpaid', NULL, NULL),
('DP-1009', 6, 2024, 250, 'late', '2024-06-20', 'cash'),
('DP-1010', 6, 2024, 200, 'unpaid', NULL, NULL);

-- ==========================================
-- PROJECTS (3: 1 ongoing, 1 completed, 1 upcoming)
-- ==========================================
INSERT INTO projects (title, title_ur, description, description_ur, status, progress_percent, start_date, end_date, budget_pkr, spent_pkr, category, location, sector, is_featured, beneficiaries_count) VALUES
(
  'Main Street Paving & Drainage',
  'مرکزی سڑک کی تعمیر اور نکاسی آب',
  'Complete repaving of the main village road with proper drainage channels to prevent monsoon flooding. Includes concrete gutters and speed breakers.',
  'مرکزی سڑک کی مکمل تعمیر نو اور نکاسی آب کی نالیوں کی تنصیب۔',
  'ongoing', 65, '2024-02-15', '2024-09-30', 450000, 292500, 'infrastructure',
  'Sector 4, West Dhab Pari', 'Sector A', true, 320
),
(
  'Solar Water Filtration Unit',
  'سولر واٹر فلٹریشن یونٹ',
  'Installation of a solar-powered water filtration plant at South Gate Square providing clean drinking water to 450+ households.',
  'جنوبی دروازے پر سولر سے چلنے والا واٹر فلٹریشن پلانٹ جو 450 سے زائد گھرانوں کو صاف پانی فراہم کرتا ہے۔',
  'completed', 100, '2023-06-01', '2024-01-15', 1100000, 1100000, 'water',
  'South Gate Square', 'Sector B', false, 450
),
(
  'Smart Learning Computer Lab',
  'سمارٹ لرننگ کمپیوٹر لیب',
  'Converting the old storeroom at Government Primary School into a modern computer lab with 15 workstations, high-speed internet, and a digital projector.',
  'سرکاری پرائمری اسکول کے پرانے اسٹور روم کو جدید کمپیوٹر لیب میں تبدیل کرنا۔',
  'upcoming', 0, NULL, NULL, 800000, 0, 'education',
  'Government Primary School Dhab Pari', 'Sector A', false, 200
);

-- ==========================================
-- DONORS (8 entries, some anonymous)
-- ==========================================
INSERT INTO donors (name, amount_pkr, date, project_id, is_anonymous, payment_method, is_verified) VALUES
('Chaudhry Ghulam Nabi', 150000, '2024-05-12', (SELECT id FROM projects WHERE title = 'Main Street Paving & Drainage'), false, 'bank', true),
('Malik Arshad', 100000, '2024-05-10', (SELECT id FROM projects WHERE title = 'Solar Water Filtration Unit'), false, 'bank', true),
('Anonymous Resident', 75000, '2024-05-05', NULL, true, 'jazzcash', true),
('Haji Muhammad Din', 50000, '2024-04-28', (SELECT id FROM projects WHERE title = 'Smart Learning Computer Lab'), false, 'bank', true),
('Raja Zahoor Ahmed', 25000, '2024-04-25', (SELECT id FROM projects WHERE title = 'Main Street Paving & Drainage'), false, 'easypaisa', true),
('Sheikh Farooq', 5000, '2024-06-01', NULL, false, 'jazzcash', true),
('Anonymous Overseas', 10000, '2024-06-03', NULL, true, 'bank', false),
('Ch. Muhammad Iqbal', 15000, '2024-06-05', (SELECT id FROM projects WHERE title = 'Main Street Paving & Drainage'), false, 'cash', true);

-- ==========================================
-- TRANSACTIONS (12 entries, mix income/expense)
-- ==========================================
INSERT INTO transactions (type, amount_pkr, date, category, description, reference_no, created_by) VALUES
('income', 45000, '2024-06-12', 'Utilities', 'Monthly Water Bills (Sector A)', 'TXN-2024-001', 'Admin'),
('expense', 12500, '2024-06-10', 'Maintenance', 'Main Pump Repair & Parts', 'TXN-2024-002', 'Admin'),
('income', 25000, '2024-06-08', 'Donation', 'Overseas Donation (A. Malik)', 'TXN-2024-003', 'Admin'),
('expense', 8200, '2024-06-05', 'Power', 'Street Light Electricity Bill', 'TXN-2024-004', 'Admin'),
('income', 67800, '2024-05-30', 'Welfare', 'Zakat Collection - Masjid', 'TXN-2024-005', 'Admin'),
('expense', 35000, '2024-05-28', 'Salaries', 'Security Guard Salaries', 'TXN-2024-006', 'Admin'),
('income', 38000, '2024-05-15', 'Utilities', 'Monthly Water Bills (Sector B)', 'TXN-2024-007', 'Admin'),
('expense', 15000, '2024-05-10', 'Maintenance', 'Pipeline Repair - North Sector', 'TXN-2024-008', 'Admin'),
('income', 150000, '2024-05-12', 'Donation', 'Ch. Ghulam Nabi - Road Project', 'TXN-2024-009', 'Admin'),
('expense', 22000, '2024-04-25', 'Infrastructure', 'Drainage Materials Purchase', 'TXN-2024-010', 'Admin'),
('income', 32000, '2024-04-20', 'Utilities', 'Monthly Water Bills (Sector C)', 'TXN-2024-011', 'Admin'),
('expense', 18500, '2024-04-15', 'Welfare', 'Free Medical Camp Expenses', 'TXN-2024-012', 'Admin');

-- ==========================================
-- NEWS POSTS (6 entries, all published)
-- ==========================================
INSERT INTO news_posts (title, title_ur, content, content_ur, category, author, is_published, views, published_at) VALUES
(
  'Village Cricket Tournament 2024 Schedule Announced',
  'گاؤں کرکٹ ٹورنامنٹ 2024 کا شیڈول',
  'Starting next month, all local teams are invited to participate in the annual cricket cup. Registration is open at the village council office. Matches will be held every Friday and Sunday.',
  'اگلے مہینے سے سالانہ کرکٹ کپ کا آغاز۔ تمام مقامی ٹیموں کو شرکت کی دعوت۔',
  'sports', 'Committee', true, 245, '2024-06-01 10:00:00+05'
),
(
  'Free Stationery Distribution for Local Primary Students',
  'مقامی پرائمری طلباء کے لیے مفت سٹیشنری کی تقسیم',
  'Dhab Pari Committee will be distributing books and stationery this Sunday at Government Primary School. All students from Class 1 to 5 are eligible.',
  'ڈھاب پڑی کمیٹی اتوار کو سرکاری پرائمری اسکول میں کتابیں اور سٹیشنری تقسیم کرے گی۔',
  'education', 'Committee', true, 189, '2024-05-28 09:30:00+05'
),
(
  'Weekly Health Clinic: New Specialized Doctor Visit',
  'ہفتہ وار ہیلتھ کلینک: نئے ماہر ڈاکٹر کا دورہ',
  'A visiting pediatric specialist will be available at the village clinic every Tuesday from 10 AM to 2 PM. Free consultation for children under 12.',
  'ہر منگل بچوں کے ماہر ڈاکٹر گاؤں کے کلینک میں دستیاب ہوں گے۔ 12 سال سے کم عمر بچوں کا مفت معائنہ۔',
  'health', 'Dr. Rashid', true, 312, '2024-05-25 11:00:00+05'
),
(
  'Green Village Initiative: 500 New Saplings Planted',
  'سبز گاؤں مہم: 500 نئے پودے لگائے گئے',
  'Community members successfully completed the spring plantation drive along the main road. Over 500 saplings of native trees including neem, shisham, and mulberry were planted.',
  'کمیونٹی ممبران نے بہار کی شجرکاری مہم کامیابی سے مکمل کی۔ 500 سے زائد مقامی درختوں کے پودے لگائے گئے۔',
  'environment', 'Committee', true, 156, '2024-05-20 08:00:00+05'
),
(
  'Eid Milan Party & Community Gathering',
  'عید ملن پارٹی اور کمیونٹی اجتماع',
  'The annual Eid Milan party was held at the village chowk with full community participation. Elders shared stories and children enjoyed games and prizes.',
  'سالانہ عید ملن پارٹی گاؤں کے چوک میں منعقد ہوئی۔ بزرگوں نے کہانیاں سنائیں اور بچوں نے کھیلوں سے لطف اندوز ہوئے۔',
  'social', 'Committee', true, 420, '2024-05-15 14:00:00+05'
),
(
  'Water Supply Schedule Change Notice',
  'پانی کی سپلائی کے شیڈول میں تبدیلی کا نوٹس',
  'Due to maintenance work on the main tank, water supply timings will change from 6 AM - 10 AM to 7 AM - 11 AM for the next two weeks.',
  'مرکزی ٹینک کی دیکھ بھال کے کام کی وجہ سے پانی کی سپلائی کے اوقات اگلے دو ہفتوں کے لیے تبدیل ہوں گے۔',
  'announcement', 'Admin', true, 534, '2024-06-10 07:00:00+05'
);

-- ==========================================
-- VIDEO CONTENT (4 entries)
-- ==========================================
INSERT INTO video_content (title, title_ur, description, video_url, thumbnail_url, category, duration_seconds, is_published, is_featured, views) VALUES
(
  'Mehmood Wedding Highlights',
  'محمود کی شادی کی تقریب',
  'Highlights from the grand wedding ceremony of Mehmood family in Dhab Pari.',
  'https://www.youtube.com/watch?v=example1',
  NULL, 'wedding', 720, true, false, 1250
),
(
  'Interview with Haji Rasheed - Village Elder',
  'حاجی رشید سے خصوصی انٹرویو',
  'An exclusive interview with village elder Haji Rasheed about the history and future of Dhab Pari.',
  'https://www.youtube.com/watch?v=example2',
  NULL, 'interview', 1500, true, true, 890
),
(
  'Annual Sports Day Highlights 2024',
  'سالانہ کھیلوں کے دن کی جھلکیاں 2024',
  'Full coverage of the annual sports day featuring cricket, kabaddi, and tug of war competitions.',
  'https://www.youtube.com/watch?v=example3',
  NULL, 'sports', 2400, true, false, 650
),
(
  'Eid Festival Celebration in Dhab Pari',
  'ڈھاب پڑی میں عید کی تقریبات',
  'Community celebration of Eid-ul-Fitr with special prayers, food distribution, and children activities.',
  'https://www.youtube.com/watch?v=example4',
  NULL, 'event', 1800, true, true, 2100
);

-- ==========================================
-- COMMITTEE MEMBERS (6 entries)
-- ==========================================
INSERT INTO committee_members (name, name_ur, position, position_ur, phone, bio, bio_ur, display_order, is_active) VALUES
('Chaudhry Ghulam Nabi', 'چوہدری غلام نبی', 'Chairman', 'چیئرمین', '0300-1111111', 'Serving the community since 2018. Leading village development and water management initiatives.', 'سن 2018 سے کمیونٹی کی خدمت۔ گاؤں کی ترقی اور پانی کے انتظام کی قیادت۔', 1, true),
('Malik Arshad Mehmood', 'ملک ارشد محمود', 'Vice Chairman', 'نائب چیئرمین', '0312-2222222', 'Overseeing infrastructure projects and community engagement programs.', 'بنیادی ڈھانچے کے منصوبوں اور کمیونٹی پروگراموں کی نگرانی۔', 2, true),
('Haji Muhammad Din', 'حاجی محمد دین', 'Treasurer', 'خزانچی', '0345-3333333', 'Managing village finances with full transparency and accountability.', 'مکمل شفافیت کے ساتھ گاؤں کے مالی معاملات کا انتظام۔', 3, true),
('Sheikh Farooq Ahmed', 'شیخ فاروق احمد', 'Secretary', 'سیکرٹری', '0331-4444444', 'Handling administrative affairs and maintaining official records.', 'انتظامی امور اور سرکاری ریکارڈ کی دیکھ بھال۔', 4, true),
('Raja Zahoor', 'راجہ ظہور', 'Water Manager', 'واٹر منیجر', '0300-5555555', 'In charge of water supply, meter readings, and bill collection.', 'پانی کی فراہمی، میٹر ریڈنگ اور بل وصولی کے انچارج۔', 5, true),
('Tariq Mehmood', 'طارق محمود', 'Youth Coordinator', 'یوتھ کوآرڈینیٹر', '0346-6666666', 'Organizing youth activities, sports events, and educational programs.', 'نوجوانوں کی سرگرمیوں، کھیلوں اور تعلیمی پروگراموں کا اہتمام۔', 6, true);

-- ==========================================
-- GALLERY ALBUMS (3 albums with 4 items each)
-- ==========================================
INSERT INTO gallery_albums (title, title_ur, category, display_order) VALUES
('Road Construction Progress', 'سڑک کی تعمیر کی پیشرفت', 'projects', 1),
('Annual Sports Day 2024', 'سالانہ کھیلوں کا دن 2024', 'sports', 2),
('Eid Celebrations', 'عید کی تقریبات', 'events', 3);

INSERT INTO gallery_items (album_id, url, caption, type, display_order) VALUES
((SELECT id FROM gallery_albums WHERE title = 'Road Construction Progress'), '/images/gallery/road-1.jpg', 'Foundation laying ceremony', 'photo', 1),
((SELECT id FROM gallery_albums WHERE title = 'Road Construction Progress'), '/images/gallery/road-2.jpg', 'Drainage channel installation', 'photo', 2),
((SELECT id FROM gallery_albums WHERE title = 'Road Construction Progress'), '/images/gallery/road-3.jpg', 'Concrete pouring in progress', 'photo', 3),
((SELECT id FROM gallery_albums WHERE title = 'Road Construction Progress'), '/images/gallery/road-4.jpg', 'Completed section of road', 'photo', 4),
((SELECT id FROM gallery_albums WHERE title = 'Annual Sports Day 2024'), '/images/gallery/sports-1.jpg', 'Cricket match final', 'photo', 1),
((SELECT id FROM gallery_albums WHERE title = 'Annual Sports Day 2024'), '/images/gallery/sports-2.jpg', 'Kabaddi tournament', 'photo', 2),
((SELECT id FROM gallery_albums WHERE title = 'Annual Sports Day 2024'), '/images/gallery/sports-3.jpg', 'Prize distribution ceremony', 'photo', 3),
((SELECT id FROM gallery_albums WHERE title = 'Annual Sports Day 2024'), '/images/gallery/sports-4.jpg', 'Tug of war competition', 'photo', 4),
((SELECT id FROM gallery_albums WHERE title = 'Eid Celebrations'), '/images/gallery/eid-1.jpg', 'Eid prayers at village mosque', 'photo', 1),
((SELECT id FROM gallery_albums WHERE title = 'Eid Celebrations'), '/images/gallery/eid-2.jpg', 'Community feast preparation', 'photo', 2),
((SELECT id FROM gallery_albums WHERE title = 'Eid Celebrations'), '/images/gallery/eid-3.jpg', 'Children enjoying Eid gifts', 'photo', 3),
((SELECT id FROM gallery_albums WHERE title = 'Eid Celebrations'), '/images/gallery/eid-4.jpg', 'Elders gathering at chowk', 'photo', 4);

-- ==========================================
-- NEWS TICKER (6 messages: 3 EN, 3 UR)
-- ==========================================
INSERT INTO news_ticker (message, message_ur, is_active, display_order) VALUES
('Water filtration plant maintenance scheduled for Friday, 10th May.', 'واٹر فلٹریشن پلانٹ کی دیکھ بھال جمعہ 10 مئی کو ہوگی۔', true, 1),
('Monthly donation report for April 2024 is now available in the Accounts section.', 'اپریل 2024 کی ماہانہ عطیات رپورٹ اکاؤنٹس سیکشن میں دستیاب ہے۔', true, 2),
('New village plantation drive starting next week — volunteers needed!', 'اگلے ہفتے نئی شجرکاری مہم شروع ہو رہی ہے — رضاکاروں کی ضرورت ہے!', true, 3),
('Last date for water bill payment is 10th of every month.', 'پانی کے بل کی ادائیگی کی آخری تاریخ ہر ماہ کی 10 تاریخ ہے۔', true, 4),
('Committee meeting this Saturday at 4 PM — all members must attend.', 'کمیٹی میٹنگ اس ہفتے شام 4 بجے — تمام اراکین کی شرکت ضروری ہے۔', true, 5),
('Free medical camp at village clinic every Tuesday 10 AM to 2 PM.', 'مفت طبی کیمپ ہر منگل صبح 10 بجے سے دوپہر 2 بجے تک گاؤں کے کلینک میں۔', true, 6);

-- ==========================================
-- SITE SETTINGS
-- ==========================================
INSERT INTO site_settings (key, value, description) VALUES
('whatsapp_number', '0300-0000000', 'Official WhatsApp contact number'),
('whatsapp_link', 'https://wa.me/923000000000', 'WhatsApp direct link'),
('jazzcash_number', '0300-0000000', 'JazzCash account number'),
('jazzcash_name', 'Dhab Pari Welfare', 'JazzCash account title'),
('easypaisa_number', '0345-0000000', 'Easypaisa account number'),
('easypaisa_name', 'DP Welfare Committee', 'Easypaisa account title'),
('bank_name', 'HBL', 'Bank name for donations'),
('bank_account', 'PK00 MCBA 0012 3456 7890 12', 'Bank IBAN number'),
('bank_branch', 'Dhab Pari Water & Welfare Branch', 'Bank branch name'),
('office_hours', 'Mon-Sat: 9AM-2PM, Fri: 9AM-12PM', 'Office working hours'),
('about_text', 'Dedicated to the prosperity and welfare of Dhab Pari village through transparent management, modern water systems, and communal support.', 'About section description'),
('vision', 'A self-sustaining village with clean water, quality education, and modern infrastructure for every household.', 'Vision statement'),
('mission', 'To provide transparent governance, efficient water management, and community-driven development through collective effort.', 'Mission statement');
