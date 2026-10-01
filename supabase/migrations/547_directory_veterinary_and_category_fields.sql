-- Migration 547: Veterinary as a new Directory category/tab, plus
-- category-specific fields for schools and mosques -- real ask,
-- 2026-10-01. Same shape as Events' category fields (539): nullable
-- columns on the one shared table, shown/required conditionally per
-- category in the admin form.
ALTER TABLE directory_entries DROP CONSTRAINT directory_entries_category_check;
ALTER TABLE directory_entries ADD CONSTRAINT directory_entries_category_check
  CHECK (category IN ('business', 'health', 'mosque', 'school', 'veterinary'));

-- School: admission status, monthly fee, current enrollment, and teacher
-- qualifications -- the real detail a parent actually wants to compare
-- schools on, not just name/phone/location.
ALTER TABLE directory_entries
  ADD COLUMN admission_status varchar CHECK (admission_status IN ('open', 'closed')),
  ADD COLUMN fee_per_month numeric(10,2),
  ADD COLUMN current_students_count int,
  ADD COLUMN teacher_qualifications text;

-- Mosque: the five daily prayer times plus Jumma -- `time` rather than
-- text so these sort/compare correctly and the UI can use a real time
-- input, not a freeform string.
ALTER TABLE directory_entries
  ADD COLUMN fajr_time time,
  ADD COLUMN zuhr_time time,
  ADD COLUMN asr_time time,
  ADD COLUMN maghrib_time time,
  ADD COLUMN isha_time time,
  ADD COLUMN jumma_time time;
