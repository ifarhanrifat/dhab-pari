-- Migration 197: show a logged-in requester what happened to their request.
--
-- submit_blood_request has recorded submitted_by_portal_user_id since 191, but
-- nothing ever showed it back. A registered user could raise a request and then
-- have no way to see whether the committee had phoned, approved it, found
-- donors, or closed it — they were in exactly the same position as an anonymous
-- visitor, despite having an account. Worse for a request that gets cancelled:
-- the committee knows, and the person who asked does not.

-- RLS on blood_requests is staff-read-only, deliberately — the table holds
-- patient names and requester numbers. So this is an RPC returning only the
-- submitter's own rows, and only the columns they already typed in themselves
-- plus what has happened since.
CREATE OR REPLACE FUNCTION my_blood_requests()
RETURNS TABLE (
  id uuid, patient_name text, patient_kind text, blood_group text, units_needed int,
  city text, hospital text, needed_on date, needed_hour int, needed_period text,
  status text, created_at timestamptz, approved_at timestamptz,
  cancelled_at timestamptz, cancel_reason text, fulfilled_at timestamptz,
  donors_contacted int, donors_said_yes int
) AS $$
  SELECT r.id, r.patient_name::text, r.patient_kind::text, r.blood_group::text, r.units_needed,
         r.city::text, r.hospital::text, r.needed_on, r.needed_hour, r.needed_period::text,
         r.status::text, r.created_at, r.approved_at,
         r.cancelled_at, r.cancel_reason, r.fulfilled_at,
         -- Counts only. Which villagers were asked, and who said no, is not the
         -- requester's business — but "eleven people were contacted, three said
         -- yes" is exactly what stops them panicking.
         (SELECT count(*)::int FROM blood_request_contacts c
           WHERE c.request_id = r.id AND c.stood_down_at IS NULL),
         (SELECT count(*)::int FROM blood_request_contacts c
           WHERE c.request_id = r.id AND c.response = 'yes' AND c.stood_down_at IS NULL)
    FROM blood_requests r
   WHERE r.submitted_by_portal_user_id = current_portal_user_id()
   ORDER BY r.created_at DESC;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION my_blood_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_blood_requests() TO authenticated;

-- ── Tell them, rather than making them check ─────────────────────────────
-- A trigger rather than three edits to approve/cancel/fulfil: it catches every
-- status change including any added later, and it does not require rewriting
-- three function bodies that have already been rewritten twice this week.
CREATE OR REPLACE FUNCTION trg_blood_request_notify_requester() RETURNS trigger AS $$
DECLARE
  v_title text;
  v_body text;
BEGIN
  IF NEW.submitted_by_portal_user_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  IF NEW.status = 'open' THEN
    v_title := 'آپ کی خون کی درخواست منظور ہو گئی';
    v_body  := 'کمیٹی نے آپ کی ' || NEW.blood_group || ' خون کی درخواست منظور کر لی ہے اور '
            || 'مماثل عطیہ دہندگان کو اطلاع بھیج دی گئی ہے۔ Your request has been approved and matching donors have been notified.';
  ELSIF NEW.status = 'cancelled' THEN
    v_title := 'آپ کی خون کی درخواست منسوخ کر دی گئی';
    v_body  := 'وجہ: ' || COALESCE(NEW.cancel_reason, 'نامعلوم')
            || '۔ کسی سوال کے لیے کمیٹی سے رابطہ کریں'
            || COALESCE(': ' || committee_contact_number(), '') || '۔';
  ELSIF NEW.status = 'fulfilled' THEN
    v_title := 'آپ کی خون کی درخواست مکمل ہو گئی';
    v_body  := 'اللہ آپ کے مریض کو صحت دے۔ عطیہ دہندگان کا شکریہ ادا کر دیا گیا ہے۔';
  ELSIF NEW.status = 'paused' THEN
    v_title := 'آپ کی خون کی درخواست عارضی طور پر روک دی گئی';
    v_body  := 'کمیٹی نے درخواست عارضی طور پر روکی ہے۔ مزید معلومات کے لیے رابطہ کریں'
            || COALESCE(': ' || committee_contact_number(), '') || '۔';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO portal_notifications (portal_user_id, event_type, title, body, link)
  VALUES (NEW.submitted_by_portal_user_id, 'blood_request_status', v_title, v_body, '/portal/blood-donor');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS blood_request_notify_requester_trigger ON blood_requests;
CREATE TRIGGER blood_request_notify_requester_trigger
  AFTER UPDATE ON blood_requests
  FOR EACH ROW EXECUTE FUNCTION trg_blood_request_notify_requester();

INSERT INTO notification_preferences (event_type, label, whatsapp_enabled, popup_enabled) VALUES
  ('blood_request_status', 'Your own blood request changes status', false, true)
ON CONFLICT (event_type) DO NOTHING;
