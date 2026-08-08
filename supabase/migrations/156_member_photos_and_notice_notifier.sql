-- Migration 156: per-member photo, and a data-driven flag for "who
-- personally informs members without WhatsApp" — the meeting-notice
-- feature (migration 155) previously hardcoded "Sarfraz Ahmed, Secretary"
-- as fixed copy; this ties it to a real committee_members row instead, so
-- it always names the actual person and their real title, and stays
-- correct if that duty is ever reassigned.
ALTER TABLE committee_members
  ADD COLUMN IF NOT EXISTS photo_url text,
  ADD COLUMN IF NOT EXISTS handles_non_whatsapp_notice boolean NOT NULL DEFAULT false;
