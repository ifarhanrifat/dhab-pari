# Dhab Pari Water & Welfare Committee Portal

Official village transparency portal for the Water & Welfare Committee of Dhab Pari, District Chakwal, Punjab, Pakistan.

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript, Tailwind CSS v4)
- **Database:** Supabase (PostgreSQL + Auth + Storage + RLS)
- **UI:** Playfair Display + Source Sans 3 + Noto Nastaliq Urdu
- **Icons:** Lucide React
- **Charts:** Recharts
- **Forms:** Zod validation, Sonner toasts

## Getting Started

### 1. Clone and Install

```bash
git clone <repo-url>
cd dhab-pari
npm install
```

### 2. Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Copy your project URL and anon key
3. Create `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXT_PUBLIC_SITE_URL=https://dhabpari.com
```

### 3. Run Migrations

In the Supabase SQL Editor, run these files in order:

1. `supabase/migrations/001_schema.sql` — Creates all tables
2. `supabase/migrations/002_rls.sql` — Enables RLS policies
3. `supabase/migrations/003_seed.sql` — Seed data
4. `supabase/migrations/004_storage.sql` — Storage buckets

### 4. Create Admin User

In Supabase Dashboard > Authentication > Users > Add User:
- Email: `admin@dhabpari.com`
- Password: (your choice)
- Auto Confirm: Yes

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## Deploy to Vercel

1. Push code to GitHub
2. Import project in [vercel.com](https://vercel.com)
3. Add environment variables (same as `.env.local`)
4. Deploy

### Add Custom Domain (dhabpari.com)

1. In Vercel > Project Settings > Domains
2. Add `dhabpari.com` and `www.dhabpari.com`
3. Update DNS records at your domain registrar:
   - A record: `76.76.21.21`
   - CNAME `www`: `cname.vercel-dns.com`

## Common Admin Tasks

### Mark Bills as Paid

1. Login at `/admin/login`
2. Go to Billing > find the consumer
3. Click "Mark Paid" button

### Add a News Post

1. Admin > News > "New Post"
2. Fill in English title + content
3. Optionally add Urdu title + content
4. Select category, upload cover image
5. Check "Publish immediately" and save

### Update Payment Numbers

1. Admin > Settings
2. Update JazzCash, Easypaisa, or Bank fields
3. Click "Save All"
4. Changes reflect immediately on the public Donate page

### Add a New Project

1. Admin > Projects > "New Project"
2. Fill in title, description, category, location
3. Set status (upcoming/ongoing/completed)
4. Upload before/after photos
5. Adjust progress slider

## Project Structure

```
src/
  app/
    (public)/          Public pages (home, water, projects, etc.)
    admin/
      login/           Admin login
      (dashboard)/     Protected admin pages (billing, news, etc.)
  components/
    layout/            Header, Footer, Sidebar, BottomNav
    admin/             ImageUpload, VideoUpload
    home/              Home page sections
    ui/                Shared UI (Button, Skeleton)
  lib/
    constants.ts       Site configuration
    translations.ts    EN/UR translations
    supabase/          Supabase clients (browser + server)
  hooks/
    useTranslation.ts  Language toggle
```

## Database Tables

| Table | Purpose |
|---|---|
| consumers | Water connection holders |
| bills | Monthly water bills |
| projects | Village welfare projects |
| project_media | Project photos/videos |
| donors | Donation records |
| transactions | Income/expense ledger |
| news_posts | Village news articles |
| video_content | Video library |
| suggestions | Community feedback |
| committee_members | Committee team |
| gallery_albums | Photo albums |
| gallery_items | Album photos |
| news_ticker | Announcement bar messages |
| site_settings | Configurable site values |
| notifications_log | WhatsApp message log |
