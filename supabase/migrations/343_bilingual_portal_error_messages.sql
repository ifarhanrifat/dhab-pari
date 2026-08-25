-- Migration 343: friendlyError() (src/lib/errors.ts) passes a RAISE
-- EXCEPTION message straight through to the toast, in whatever language it
-- was written in — it has no locale awareness, and making it locale-aware
-- would mean threading isUrdu through 144 existing call sites, well beyond
-- this fix. So instead: every portal-facing (villager-triggered, not
-- admin-only) error message this session actually added becomes bilingual
-- in the string itself — Urdu sentence, then the English one — same
-- pattern already used for the chat privacy notice (migration 324). A
-- reader gets a sentence in their own language regardless of which half of
-- the UI happens to be in which language at that moment.
CREATE OR REPLACE FUNCTION start_mentor_conversation(p_mentor_portal_user_id uuid) RETURNS uuid AS $$
DECLARE
  v_student_id uuid;
  v_conversation_id uuid;
  v_mentor_status varchar;
  v_mentor_available boolean;
BEGIN
  v_student_id := current_portal_user_id();
  IF v_student_id IS NULL THEN
    RAISE EXCEPTION 'لاگ ان درکار ہے۔ Not authenticated.';
  END IF;
  IF v_student_id = p_mentor_portal_user_id THEN
    RAISE EXCEPTION 'آپ خود سے گفتگو شروع نہیں کر سکتے۔ You cannot start a conversation with yourself.';
  END IF;

  SELECT mentor_status, mentor_available INTO v_mentor_status, v_mentor_available
  FROM portal_users WHERE id = p_mentor_portal_user_id;
  IF v_mentor_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'یہ رہنما بات چیت کے لیے دستیاب نہیں ہے۔ This mentor is not available for chat.';
  END IF;
  IF NOT COALESCE(v_mentor_available, false) THEN
    RAISE EXCEPTION 'یہ رہنما فی الحال نئی گفتگو قبول نہیں کر رہا۔ This mentor is currently not accepting new conversations.';
  END IF;
  IF EXISTS (SELECT 1 FROM mentor_chat_blocks WHERE blocker_portal_user_id = p_mentor_portal_user_id AND blocked_portal_user_id = v_student_id) THEN
    RAISE EXCEPTION 'یہ رہنما آپ سے بات چیت کے لیے دستیاب نہیں ہے۔ This mentor is not available to chat with you.';
  END IF;

  INSERT INTO mentor_conversations (student_portal_user_id, mentor_portal_user_id)
  VALUES (v_student_id, p_mentor_portal_user_id)
  ON CONFLICT (student_portal_user_id, mentor_portal_user_id) DO UPDATE SET status = 'open'
  RETURNING id INTO v_conversation_id;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION register_for_training_program(p_training_program_id uuid) RETURNS void AS $$
DECLARE
  v_portal_user_id uuid;
  v_capacity int;
  v_registered_count int;
  v_status varchar;
BEGIN
  v_portal_user_id := current_portal_user_id();
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'لاگ ان درکار ہے۔ Not authenticated.'; END IF;

  SELECT capacity, status INTO v_capacity, v_status FROM training_programs WHERE id = p_training_program_id;
  IF v_status IS NULL THEN RAISE EXCEPTION 'پروگرام نہیں ملا۔ Program not found.'; END IF;
  IF v_status NOT IN ('upcoming', 'ongoing') THEN
    RAISE EXCEPTION 'اس پروگرام کے لیے رجسٹریشن بند ہے۔ Registration is closed for this program.';
  END IF;

  IF v_capacity IS NOT NULL THEN
    SELECT count(*) INTO v_registered_count FROM training_program_registrations
      WHERE training_program_id = p_training_program_id AND status = 'registered';
    IF v_registered_count >= v_capacity THEN
      RAISE EXCEPTION 'یہ پروگرام مکمل بھر چکا ہے۔ This program is full.';
    END IF;
  END IF;

  INSERT INTO training_program_registrations (training_program_id, portal_user_id)
  VALUES (p_training_program_id, v_portal_user_id)
  ON CONFLICT (training_program_id, portal_user_id) DO UPDATE SET status = 'registered';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION trg_mentor_message_guard() RETURNS trigger AS $$
BEGIN
  IF contains_contact_info(NEW.content) THEN
    RAISE EXCEPTION 'پیغام نہیں بھیجا گیا — چیٹ میں فون نمبر، واٹس ایپ لنکس یا ای میل شیئر کرنا اجازت نہیں ہے۔ Message not sent — sharing phone numbers, WhatsApp links, or email addresses in chat isn''t allowed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_talent_showcase_guardian_guard() RETURNS trigger AS $$
DECLARE
  v_is_minor boolean;
  v_guardian_name varchar;
  v_guardian_mobile varchar;
BEGIN
  IF NEW.portal_user_id IS NOT NULL THEN
    SELECT is_minor, guardian_name, guardian_mobile INTO v_is_minor, v_guardian_name, v_guardian_mobile
      FROM portal_users WHERE id = NEW.portal_user_id;
    IF v_is_minor AND (v_guardian_name IS NULL OR v_guardian_mobile IS NULL) THEN
      RAISE EXCEPTION '18 سال سے کم عمر کے لیے ٹیلنٹ شو کیس اندراج جمع کروانے سے پہلے والدین/سرپرست کا نام اور موبائل نمبر ہونا ضروری ہے — پہلے اپنے پروفائل میں شامل کریں۔ A parent/guardian name and mobile number must be on file before submitting a talent showcase entry for someone under 18 — add this on your profile page first.';
    END IF;
  ELSIF NEW.submitted_by_admin_id IS NOT NULL AND NOT NEW.guardian_consent_confirmed_by_admin THEN
    RAISE EXCEPTION 'Confirm guardian consent has been obtained before submitting an entry on someone else''s behalf.';
  END IF;
  NEW.is_published := false;
  NEW.moderation_status := 'pending';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
