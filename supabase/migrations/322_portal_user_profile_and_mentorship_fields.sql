-- Migration 322: Phase A of the student mentorship/freelancing initiative —
-- profile fields only. Nothing here unlocks chat, showcase publishing, or
-- mentor status; those are later phases with their own tables. This just
-- gives a portal_user somewhere to say who they are and what kind of help
-- they're looking for, so those later features have something to key off.
--
-- gender uses the same two-value convention as wazifa_students (migration
-- 212) rather than inventing a new one.
--
-- guardian_name/guardian_mobile are collected now (not deferred to the
-- Talent Showcase phase) because "ask once, reuse everywhere" beats asking
-- a minor's contact twice — Phase B's showcase-submission review will read
-- these rather than re-collecting them. Self-declared, not age-verified:
-- there is no reliable way to verify a village teenager's age online, so
-- this is a plain question ("are you under 18?"), same trust level as every
-- other self-reported field on this form.
ALTER TABLE portal_users
  ADD COLUMN IF NOT EXISTS gender varchar CHECK (gender IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS profession varchar,
  ADD COLUMN IF NOT EXISTS profession_other varchar,
  ADD COLUMN IF NOT EXISTS education_level varchar
    CHECK (education_level IN ('below_matric', 'matric', 'intermediate', 'diploma', 'bachelors', 'masters', 'phd', 'other')),
  ADD COLUMN IF NOT EXISTS education_details text,
  ADD COLUMN IF NOT EXISTS is_currently_studying boolean,
  ADD COLUMN IF NOT EXISTS seeking_mentorship boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_minor boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS guardian_name varchar,
  ADD COLUMN IF NOT EXISTS guardian_mobile varchar,
  ADD COLUMN IF NOT EXISTS phone_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN portal_users.profession IS
  'One of: student, freelancer, farmer, laborer, government_employee, private_employee, business_owner, teacher, unemployed, other. Free column (not a CHECK) — same reasoning as volunteers.help_types (migration 179): the form offers a fixed list, the list will grow, and that should be a code change, not a migration.';
COMMENT ON COLUMN portal_users.seeking_mentorship IS
  'Self-declared interest in the freelancing/mentorship program (courses, institute directory, mentor chat, training programs). Drives visibility into those Phase B/C/D features once built; does not by itself grant anything.';
COMMENT ON COLUMN portal_users.phone_private IS
  'A visible promise shown back to the user, not a new access grant — portal_users has been admin/super_admin-only-readable for every row since migration 121 regardless of this flag. Kept as an explicit column so later service-role code paths (bulk notification sends, mentor-facing views) have something concrete to check before ever surfacing a number.';
COMMENT ON COLUMN portal_users.is_minor IS
  'Self-declared "I am under 18" — see guardian_name/guardian_mobile. Used to require admin review + a guardian contact on record before any Talent Showcase or mentor-chat feature (Phase B/D) goes live for this account.';
