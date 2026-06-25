CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE consumers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id varchar UNIQUE NOT NULL,
  name varchar NOT NULL,
  name_ur varchar,
  mobile varchar NOT NULL,
  address text,
  area varchar,
  house_no varchar,
  sector varchar,
  connection_date date,
  status varchar DEFAULT 'active'
    CHECK (status IN ('active','inactive')),
  monthly_rate decimal DEFAULT 200,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id varchar NOT NULL
    REFERENCES consumers(consumer_id),
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  year int NOT NULL,
  amount_pkr decimal DEFAULT 200,
  status varchar DEFAULT 'unpaid'
    CHECK (status IN ('paid','unpaid','pending','late')),
  paid_date date,
  payment_method varchar
    CHECK (payment_method IN
      ('jazzcash','easypaisa','bank','cash')),
  receipt_no varchar,
  created_at timestamptz DEFAULT now(),
  UNIQUE(consumer_id, month, year)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  description text,
  description_ur text,
  status varchar DEFAULT 'upcoming'
    CHECK (status IN
      ('ongoing','completed','upcoming')),
  progress_percent int DEFAULT 0
    CHECK (progress_percent BETWEEN 0 AND 100),
  start_date date,
  end_date date,
  budget_pkr decimal,
  spent_pkr decimal DEFAULT 0,
  category varchar
    CHECK (category IN
      ('infrastructure','water','health',
       'education','environment','welfare','other')),
  location varchar,
  sector varchar,
  is_featured bool DEFAULT false,
  before_image_url text,
  after_image_url text,
  beneficiaries_count int,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE project_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  type varchar DEFAULT 'photo'
    CHECK (type IN ('photo','video')),
  caption text,
  is_before bool DEFAULT false,
  is_after bool DEFAULT false,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE donors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  amount_pkr decimal NOT NULL,
  date date NOT NULL,
  project_id uuid REFERENCES projects(id),
  is_anonymous bool DEFAULT false,
  payment_method varchar,
  is_verified bool DEFAULT false,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar NOT NULL
    CHECK (type IN ('income','expense')),
  amount_pkr decimal NOT NULL,
  date date NOT NULL,
  category varchar NOT NULL,
  description text NOT NULL,
  reference_no varchar,
  created_by varchar,
  receipt_url text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE news_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  content text NOT NULL,
  content_ur text,
  category varchar
    CHECK (category IN
      ('sports','education','health',
       'environment','social','announcement','event')),
  cover_image_url text,
  author varchar DEFAULT 'Committee',
  is_published bool DEFAULT false,
  views int DEFAULT 0,
  published_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE video_content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  description text,
  video_url text NOT NULL,
  thumbnail_url text,
  category varchar
    CHECK (category IN
      ('wedding','interview','event',
       'sports','news','documentary','project')),
  duration_seconds int,
  is_published bool DEFAULT false,
  is_featured bool DEFAULT false,
  views int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar,
  mobile varchar,
  message text NOT NULL,
  type varchar DEFAULT 'suggestion'
    CHECK (type IN
      ('suggestion','volunteer',
       'complaint','general')),
  status varchar DEFAULT 'new'
    CHECK (status IN ('new','reviewed','actioned')),
  admin_notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE committee_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar NOT NULL,
  name_ur varchar,
  position varchar NOT NULL,
  position_ur varchar,
  phone varchar,
  bio text,
  bio_ur text,
  display_order int DEFAULT 0,
  is_active bool DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE gallery_albums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar NOT NULL,
  title_ur varchar,
  category varchar
    CHECK (category IN
      ('projects','sports','kids',
       'events','weddings','interviews')),
  cover_url text,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE gallery_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id uuid NOT NULL
    REFERENCES gallery_albums(id) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  type varchar DEFAULT 'photo'
    CHECK (type IN ('photo','video')),
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE news_ticker (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL,
  message_ur text,
  is_active bool DEFAULT true,
  display_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE site_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar UNIQUE NOT NULL,
  value text,
  description text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE notifications_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar CHECK (type IN ('whatsapp','sms','email')),
  recipient varchar,
  message text,
  status varchar DEFAULT 'pending'
    CHECK (status IN ('sent','failed','pending')),
  sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);
