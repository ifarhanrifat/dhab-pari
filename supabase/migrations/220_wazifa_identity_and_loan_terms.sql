-- Migration 220: the identity fields the verification sheet needs, and a
-- qarz-e-hasana that reads like an obligation.
--
-- ═════════════════════════════════════════════════════════════════════════
-- 1. Nothing to check against
-- ═════════════════════════════════════════════════════════════════════════
-- The verification sheet asks a committee member to confirm "CNIC / B-form
-- seen, name matches the form" — but the form never asked for a CNIC number,
-- so there was nothing to match it against. The verifier could only confirm
-- that a card existed, which is not the same thing at all.
ALTER TABLE wazifa_students
  ADD COLUMN IF NOT EXISTS b_form_no varchar,
  ADD COLUMN IF NOT EXISTS guardian_cnic varchar;

ALTER TABLE wazifa_applications
  -- Copied onto the application as declared, so a later correction to the
  -- student record does not silently rewrite what was verified.
  ADD COLUMN IF NOT EXISTS declared_cnic varchar,
  ADD COLUMN IF NOT EXISTS declared_b_form_no varchar,
  ADD COLUMN IF NOT EXISTS declared_dob date,
  ADD COLUMN IF NOT EXISTS declared_address text;

CREATE OR REPLACE FUNCTION trg_wazifa_application_copy_identity() RETURNS trigger AS $$
BEGIN
  -- Keeps the student record and the application in step without either one
  -- overwriting the other after the fact.
  UPDATE wazifa_students s SET
    cnic = COALESCE(NULLIF(trim(NEW.declared_cnic), ''), s.cnic),
    b_form_no = COALESCE(NULLIF(trim(NEW.declared_b_form_no), ''), s.b_form_no),
    date_of_birth = COALESCE(NEW.declared_dob, s.date_of_birth),
    address = COALESCE(NULLIF(trim(NEW.declared_address), ''), s.address),
    updated_at = now()
  WHERE s.id = NEW.student_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS wazifa_application_copy_identity ON wazifa_applications;
CREATE TRIGGER wazifa_application_copy_identity
  AFTER INSERT ON wazifa_applications
  FOR EACH ROW EXECUTE FUNCTION trg_wazifa_application_copy_identity();

-- The verifier now checks the number, not merely the existence of a card.
ALTER TABLE wazifa_verifications
  ADD COLUMN IF NOT EXISTS cnic_matches varchar CHECK (cnic_matches IN ('yes', 'no', 'na')),
  ADD COLUMN IF NOT EXISTS verified_cnic varchar;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. A loan that reads like a loan
-- ═════════════════════════════════════════════════════════════════════════
-- The first version of the agreement promised that instalments "can be
-- forgiven" and that "the committee will not take legal action". Both were
-- written to be kind and both were a mistake: a debt advertised as forgivable
-- is one people plan around, and the fund stops revolving. The next student is
-- paid for by the last one returning the money, or not at all.
--
-- What stays is deferral, because Qur'an 2:280 commands giving a debtor in
-- difficulty time — "and if you remit it by way of charity, that is best for
-- you" is addressed to the lender as a virtue, not to the borrower as an
-- expectation. So the committee keeps the power to remit; it simply stops
-- advertising it on the form somebody signs.
UPDATE site_settings SET value =
E'۱۔ یہ رقم قرضِ حسنہ ہے۔ اس پر کوئی سود، منافع یا اضافی رقم نہیں ہے اور نہ کبھی ہوگی۔ آپ نے بالکل اتنی ہی رقم واپس کرنی ہے جتنی آپ پر خرچ کی گئی — نہ ایک روپیہ زیادہ، نہ ایک روپیہ کم۔\n\n۲۔ یہ رقم آپ کے ذمے واجب الادا ہے۔ واپسی اُس وقت شروع ہوگی جب آپ کو باقاعدہ آمدن حاصل ہو جائے، یا تعلیم مکمل ہونے کے چھ ماہ بعد — جو بھی پہلے ہو۔\n\n۳۔ اقساط کی تعداد اور رقم کمیٹی آپ سے مشورے کے بعد طے کرے گی، آپ کی آمدن کو دیکھتے ہوئے۔\n\n۴۔ اگر آپ کو ملازمت نہ ملے یا کسی حقیقی مشکل کا سامنا ہو تو فوراً کمیٹی کو اطلاع دیں۔ ایسی صورت میں اقساط مؤخر کر دی جائیں گی اور آپ کو مہلت دی جائے گی۔ خاموش رہنا مشکل کا حل نہیں۔\n\n۵۔ زیرِ تعلیم رہتے ہوئے آپ نے جو ماہانہ حصہ ادا کرنے کا وعدہ کیا ہے، وہ الگ ہے اور اسے باقاعدگی سے ادا کرنا ہے۔ یہی اس بات کا ثبوت ہے کہ آپ واقعی زیرِ تعلیم اور سنجیدہ ہیں۔\n\n۶۔ اپنا پتہ، فون نمبر، تعلیمی ادارہ اور ملازمت کی ہر تبدیلی سے کمیٹی کو آگاہ رکھیں۔\n\n۷۔ آپ کی واپس کی گئی رقم اسی فنڈ میں جائے گی اور اس سے گاؤں کے اگلے طالبِ علم کی تعلیم ہوگی۔ آپ کی ادائیگی کسی اور کے مستقبل کا انحصار ہے۔\n\n۸۔ یہ اللہ کے حضور اور اہلِ گاؤں کے سامنے ایک وعدہ ہے۔ اسے پورا کرنا آپ کی دینی اور اخلاقی ذمہ داری ہے۔'
WHERE key = 'wazifa_loan_terms_ur';

UPDATE site_settings SET value =
E'1. This is a qarz-e-hasana. There is no interest, profit or charge of any kind on it, and there never will be. You return exactly what was spent on you — not one rupee more, and not one rupee less.\n\n2. This money is owed. Repayment begins once you have a regular income, or six months after you finish your studies, whichever comes first.\n\n3. The number and size of the instalments are settled with you by the committee, in the light of what you are earning.\n\n4. If you do not find work, or you meet genuine hardship, tell the committee at once. Instalments will be deferred and you will be given time. Going quiet is not a way out of a difficulty.\n\n5. The monthly share you agreed to pay while you are studying is separate from this, and is to be paid regularly. It is what shows the committee that you are genuinely enrolled and genuinely serious.\n\n6. Keep the committee informed of every change of address, phone number, institution and job.\n\n7. What you return goes back into this fund and pays for the next student from this village. Somebody else''s future depends on your instalments.\n\n8. This is a promise made before Allah and before the people of your village. Keeping it is a religious and moral obligation.'
WHERE key = 'wazifa_loan_terms_en';

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Remission becomes a committee act, not an advertised option
-- ═════════════════════════════════════════════════════════════════════════
-- The committee can still forgive a loan — that is its right and, where the
-- hardship is real, its virtue. It now has to be a decision somebody records
-- and signs for, rather than a line on a form promising it in advance.
ALTER TABLE wazifa_awards
  ADD COLUMN IF NOT EXISTS written_off_pkr decimal NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS written_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS written_off_by uuid REFERENCES admin_users(id),
  ADD COLUMN IF NOT EXISTS write_off_reason text;

CREATE OR REPLACE FUNCTION wazifa_write_off_loan(
  p_award_id uuid, p_amount decimal, p_reason text
) RETURNS jsonb AS $$
DECLARE
  aw wazifa_awards%ROWTYPE; st wazifa_students%ROWTYPE;
  v_outstanding decimal; v_expense uuid; v_receivable uuid;
  v_voucher_no varchar;
BEGIN
  -- Deliberately a higher bar than taking a repayment: forgiving a debt owed
  -- to the village is a committee decision, not a counter transaction.
  IF NOT COALESCE(current_admin_permission('approve_transactions'), false) THEN
    RAISE EXCEPTION 'Only an approver can write off a qarz-e-hasana.' USING ERRCODE = 'P0001';
  END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Write down why this loan is being forgiven. It is money the village will not get back.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO aw FROM wazifa_awards WHERE id = p_award_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award not found' USING ERRCODE = 'P0001'; END IF;
  IF NOT aw.is_loan THEN RAISE EXCEPTION 'This was a grant — there is nothing to write off.' USING ERRCODE = 'P0001'; END IF;

  v_outstanding := aw.awarded_amount_pkr - aw.repaid_pkr - aw.written_off_pkr;
  IF p_amount > v_outstanding + 0.01 THEN
    RAISE EXCEPTION 'Only Rs % is still outstanding.', trim(to_char(v_outstanding, 'FM999,999,999,990'))
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO st FROM wazifa_students WHERE id = aw.student_id;
  SELECT id INTO v_expense FROM accounts WHERE system = 'donors_projects' AND code = 'DP-5020';
  SELECT id INTO v_receivable FROM accounts WHERE system = 'donors_projects' AND code = 'DP-4020';

  -- The moment a loan stops being an asset and becomes expenditure.
  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, wazifa_student_id, wazifa_award_id)
  VALUES ('donors_projects', 'expense', (now() AT TIME ZONE 'Asia/Karachi')::date,
    st.code || ' · qarz-e-hasana written off · ' || trim(p_reason), p_amount,
    v_receivable, v_expense, st.full_name, aw.student_id, aw.id)
  RETURNING voucher_no INTO v_voucher_no;

  UPDATE wazifa_awards
     SET written_off_pkr = written_off_pkr + p_amount,
         written_off_at = now(), written_off_by = current_admin_user_id(),
         write_off_reason = p_reason,
         status = CASE WHEN repaid_pkr + written_off_pkr + p_amount >= awarded_amount_pkr - 0.01
                       THEN 'completed' ELSE status END
   WHERE id = p_award_id;

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'written_off', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION wazifa_write_off_loan(uuid, decimal, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_write_off_loan(uuid, decimal, text) TO authenticated;

-- Everything a committee member needs on one screen before deciding, and
-- everything the printed sheet has to show.
CREATE OR REPLACE FUNCTION wazifa_loan_position(p_award_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'awarded', a.awarded_amount_pkr,
    'repaid', a.repaid_pkr,
    'contributed', a.contributed_pkr,
    'written_off', a.written_off_pkr,
    'outstanding', GREATEST(a.awarded_amount_pkr - a.repaid_pkr - a.written_off_pkr, 0),
    'monthly_contribution', a.student_monthly_contribution_pkr,
    'instalments', (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id),
    'paid_instalments', (SELECT count(*) FROM wazifa_repayment_schedule WHERE award_id = a.id AND status = 'paid'),
    'overdue', (SELECT count(*) FROM wazifa_repayment_schedule
                 WHERE award_id = a.id AND status IN ('due', 'part_paid')
                   AND due_on < (now() AT TIME ZONE 'Asia/Karachi')::date),
    'next_due_on', (SELECT min(due_on) FROM wazifa_repayment_schedule
                     WHERE award_id = a.id AND status IN ('due', 'part_paid'))
  ) FROM wazifa_awards a WHERE a.id = p_award_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
