-- Public site white-labeling, part 1 (schema): most of what the public
-- site needs (whatsapp_number, whatsapp_link, footer_whatsapp_group_link,
-- footer_facebook_link, jazzcash_number/name, easypaisa_number/name,
-- bank_name/account/branch, office_hours, contact_email) already exists
-- in site_settings, tenant-scoped since migration 566 -- it was just
-- never read by the public site's own components (Header/Footer/
-- homepage), only by the admin-side receipt/invoice templates. Only a
-- handful of genuinely new keys are needed: a tenant's full display name
-- differs from its short one only for dhab-pari's own historical split
-- (every tenant created since multi-tenancy stores its whole name
-- directly in tenants.name already), plus a few fields with no existing
-- home at all (tagline, district/province/location/established, village
-- coordinates for the weather widget).
insert into site_settings (tenant_id, key, value, description) values
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_full_name', 'Dhab Pari Water & Welfare Committee', 'Public site: full committee name for page titles/headers. Falls back to the tenant''s own name if unset.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_full_name_ur', 'ڈھاب پڑی واٹر اینڈ ویلفیئر کمیٹی', 'Public site: full committee name (Urdu).'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_short_committee', 'Dhab Pari Committee', 'Public site: short form used in a few tight spots (e.g. JazzCash/bank account title defaults).'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_tagline_ur', 'ڈھاب پڑی واٹر اینڈ ویلفیئر کمیٹی - آپ کی خدمت، ہمارا مشن', 'Public site: Urdu tagline under the homepage hero.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_district', 'Chakwal', 'Public site: district, shown in the footer office block.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_province', 'Punjab', 'Public site: province, shown in the footer office block.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_location', 'Dhab Pari, Dist. Chakwal, Punjab, Pakistan', 'Public site: one-line location string used in meta descriptions.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_established', '2018', 'Public site: year the committee was established, shown on the About page.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'village_lat', '32.9', 'Public site: village latitude for the homepage weather widget. Blank hides the widget.'),
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'village_lng', '72.85', 'Public site: village longitude for the homepage weather widget.')
on conflict (tenant_id, key) do nothing;
