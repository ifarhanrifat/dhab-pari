-- Phase 1 of the card-based redesign, 2026-10-12. The new design's
-- `image-slot` placeholders are backed by their own real tables wherever
-- one already exists (projects.before/after_image_url, project_media,
-- classified_listings.photo_url, video_content.thumbnail_url) -- this
-- table is only for the handful of slots with no natural home: the
-- public committee logo (today's site_settings branding keys are
-- text-only) and the decorative welfare/mentor card thumbnails the new
-- design invents. Reuses the existing tenant-scoped site_settings
-- pattern (key/value) rather than a bespoke shape, since this is really
-- just more branding configuration, one row per named slot.
create table if not exists site_card_images (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) default coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid),
  slot_key varchar not null,
  image_url text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, slot_key)
);

create index if not exists site_card_images_tenant_id_idx on site_card_images (tenant_id);

alter table site_card_images enable row level security;

-- Public read (anonymous homepage visitors need these images), same
-- subdomain-fallback pattern as every other public-site table fixed in
-- migrations 624/637/640 -- request_tenant_id() covers an anonymous
-- visit to a tenant's own subdomain, my_tenant_id() covers an
-- authenticated admin session, the hardcoded id is dhab-pari's own
-- fallback on the primary domain.
create policy "site_card_images_read_public" on site_card_images for select
  using (tenant_id = coalesce(my_tenant_id(), request_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid));

create policy "site_card_images_write_admin" on site_card_images for all to authenticated
  using (tenant_id = my_tenant_id() and current_admin_is_admin_tier())
  with check (tenant_id = my_tenant_id() and current_admin_is_admin_tier());
