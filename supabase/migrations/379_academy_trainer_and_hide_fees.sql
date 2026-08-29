-- Migration 379: the "professional academy" pass — three genuinely new
-- pieces the strategy discussion identified as missing (everything else,
-- slots/villager-outsider rates/sibling discounts/cover photo via
-- after_image_url, already existed):
--
--   1. hide_fees — a project can hide its villager/outsider rate card
--      from the public catalog (distinct from hide_donor_names, which is
--      about who *donated*, not what students *pay*).
--   2. A trainer's public bio/photo, on admin_users alongside the
--      existing assigned_training_program_ids (367) — same precedent as
--      portal_users.mentor_bio for the portal-side mentor feature.
--   3. academy_trainers_public() — a bulk, name-only read so the catalog
--      page can show "meet your trainer" without exposing anything else
--      on the admin_users row (email, permissions, etc.) to the public.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS hide_fees boolean NOT NULL DEFAULT false;

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS trainer_bio text,
  ADD COLUMN IF NOT EXISTS trainer_bio_ur text,
  ADD COLUMN IF NOT EXISTS trainer_photo_url text;

CREATE OR REPLACE FUNCTION academy_trainers_public() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'project_id', pid,
    'trainer_name', au.full_name,
    'trainer_bio', au.trainer_bio,
    'trainer_bio_ur', au.trainer_bio_ur,
    'trainer_photo_url', au.trainer_photo_url
  )), '[]'::jsonb)
  FROM admin_users au, unnest(au.assigned_training_program_ids) AS pid
  WHERE au.is_active = true AND au.can_collect_payments = true
    AND au.assigned_training_program_ids IS NOT NULL
    -- A trainer assigned but with nothing written yet has nothing worth
    -- showing — the section just doesn't render rather than showing an
    -- empty "Meet your trainer" card with just a name in it.
    AND (au.trainer_bio IS NOT NULL OR au.trainer_bio_ur IS NOT NULL OR au.trainer_photo_url IS NOT NULL);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION academy_trainers_public() TO anon, authenticated;
