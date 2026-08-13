-- Migration 215: documents, the family check, and the qarz-e-hasana agreement.
--
-- Three gaps the first version of the application left open:
--
--   Nothing could be uploaded, so a committee member had to go to the house
--   before knowing whether the documents existed at all.
--
--   Nothing checked whether this family already had somebody on a wazifa.
--   A fund that quietly supports three brothers while a family down the road
--   gets nothing does not stay trusted for long.
--
--   Asking "will you return it?" with no terms attached is asking somebody to
--   agree to something nobody has written down.

ALTER TABLE wazifa_applications
  -- Grant or loan, chosen by the applicant rather than inferred from a
  -- checkbox. The committee can still decide otherwise, but it should know
  -- what was asked for.
  ADD COLUMN IF NOT EXISTS requested_as varchar NOT NULL DEFAULT 'grant'
    CHECK (requested_as IN ('grant', 'loan', 'either')),

  -- Families here often run one shop, one tractor, one herd between several
  -- brothers. Asking each man his "salary" gets zero from all of them and
  -- misses the actual household income entirely.
  ADD COLUMN IF NOT EXISTS has_family_business boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS family_business_kind varchar,
  ADD COLUMN IF NOT EXISTS family_business_share_pkr decimal DEFAULT 0,
  ADD COLUMN IF NOT EXISTS family_business_note text,

  -- The agreement, accepted as a typed name. Not a signature in law, but a
  -- deliberate act with a timestamp behind it — and the printed form carries
  -- a real signature line for the committee's file.
  ADD COLUMN IF NOT EXISTS loan_terms_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS loan_terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS loan_terms_signature varchar,

  -- Filled by the committee once the family check has been looked at, so a
  -- second reviewer can see it was considered rather than skipped.
  ADD COLUMN IF NOT EXISTS family_check_note text;

-- ── Uploaded documents ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wazifa_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES wazifa_applications(id) ON DELETE CASCADE,
  kind varchar NOT NULL
    CHECK (kind IN ('cnic', 'b_form', 'matric_dmc', 'fsc_dmc', 'degree',
                    'admission_letter', 'fee_challan', 'income_proof',
                    'medical', 'other')),
  label varchar,
  url text NOT NULL,
  uploaded_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  -- Marked by the verifier once the original has been seen in the hand. A
  -- photograph of a document is a claim; the original is the evidence.
  original_seen boolean NOT NULL DEFAULT false,
  seen_by uuid REFERENCES admin_users(id),
  seen_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wazifa_documents_app_idx ON wazifa_documents(application_id);

-- ═════════════════════════════════════════════════════════════════════════
-- Is this family already being helped?
-- ═════════════════════════════════════════════════════════════════════════
-- Matched on the father's name, the phone and the CNIC, because in a village
-- of a few hundred households those three catch nearly everything. It reports
-- rather than blocks: a second brother may be perfectly deserving, and the
-- committee should decide that knowingly instead of the software deciding it
-- silently.
CREATE OR REPLACE FUNCTION wazifa_family_check(
  p_father_name varchar, p_phone varchar DEFAULT NULL, p_cnic varchar DEFAULT NULL
) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'wazifa_students', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', s.code, 'name', s.full_name, 'status', s.status,
        'awarded', (SELECT COALESCE(SUM(awarded_amount_pkr), 0) FROM wazifa_awards w
                     WHERE w.student_id = s.id AND w.status IN ('active', 'completed'))
      )), '[]'::jsonb)
      FROM wazifa_students s
      WHERE (nullif(trim(p_father_name), '') IS NOT NULL AND lower(trim(s.father_name)) = lower(trim(p_father_name)))
         OR (nullif(trim(p_phone), '') IS NOT NULL AND s.phone = trim(p_phone))
         OR (nullif(trim(p_cnic), '') IS NOT NULL AND s.cnic = trim(p_cnic))
    ),
    'kafalat_children', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'code', c.code, 'name', c.first_name, 'status', c.status
      )), '[]'::jsonb)
      FROM kafalat_children c
      WHERE nullif(trim(p_father_name), '') IS NOT NULL
        AND (lower(trim(c.guardian_name)) = lower(trim(p_father_name))
             OR (nullif(trim(p_phone), '') IS NOT NULL AND c.guardian_phone = trim(p_phone)))
    ),
    'needs_register', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('code', n.code, 'status', n.status)), '[]'::jsonb)
      FROM needs_register n
      WHERE (nullif(trim(p_phone), '') IS NOT NULL AND n.phone = trim(p_phone))
         OR (nullif(trim(p_cnic), '') IS NOT NULL AND n.cnic = trim(p_cnic))
         OR (nullif(trim(p_father_name), '') IS NOT NULL
             AND lower(trim(n.father_husband_name)) = lower(trim(p_father_name)))
    )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- Committee only. An applicant does not get to enumerate who else in the
-- village is receiving help.
REVOKE ALL ON FUNCTION wazifa_family_check(varchar, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wazifa_family_check(varchar, varchar, varchar) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- The agreement
-- ═════════════════════════════════════════════════════════════════════════
-- Held in Settings so the committee can revise it without a developer, and so
-- the text a student agreed to can be reprinted years later.
--
-- The last clause matters more than the rest. A village committee is not
-- going to take a graduate to court, and pretending otherwise would be a lie
-- printed on its own form. Saying plainly that this is a promise before Allah
-- and the village, and that genuine hardship will be met with deferral or
-- forgiveness rather than pursuit, is both true and — going by how Akhuwat's
-- repayment rates run against conventional lending — more effective.
INSERT INTO site_settings (key, value) VALUES
  ('wazifa_loan_terms_ur',
   E'۱۔ یہ رقم قرضِ حسنہ ہے۔ اس پر کوئی سود، منافع یا اضافی رقم نہیں ہے اور نہ کبھی ہوگی۔ آپ نے بالکل اتنی ہی رقم واپس کرنی ہے جتنی آپ کو دی گئی۔\n\n۲۔ واپسی اُس وقت شروع ہوگی جب آپ کو باقاعدہ آمدن حاصل ہو جائے، یا تعلیم مکمل ہونے کے چھ ماہ بعد — جو بھی پہلے ہو۔\n\n۳۔ اقساط کی تعداد اور رقم کمیٹی آپ سے مشورے کے بعد طے کرے گی، آپ کی آمدن کو دیکھتے ہوئے۔\n\n۴۔ اگر آپ کو ملازمت نہ ملے، یا بیماری یا کسی حقیقی مشکل کا سامنا ہو، تو کمیٹی سے رجوع کریں۔ ایسی صورت میں اقساط مؤخر کی جا سکتی ہیں یا معاف بھی کی جا سکتی ہیں۔ آپ سے تقاضا نہیں کیا جائے گا۔\n\n۵۔ اپنا پتہ، فون نمبر اور ملازمت کی تبدیلی سے کمیٹی کو آگاہ رکھیں۔\n\n۶۔ آپ کی واپس کی گئی رقم اسی فنڈ میں جائے گی اور اس سے گاؤں کے اگلے طالبِ علم کی تعلیم ہوگی۔\n\n۷۔ یہ عدالتی دستاویز نہیں۔ یہ اللہ کے حضور اور اہلِ گاؤں کے سامنے ایک وعدہ ہے۔ کمیٹی آپ کے خلاف کوئی قانونی کارروائی نہیں کرے گی۔'),
  ('wazifa_loan_terms_en',
   E'1. This is a qarz-e-hasana. There is no interest, profit or charge of any kind on it, and there never will be. You return exactly what you were given — not one rupee more.\n\n2. Repayment begins once you have a regular income, or six months after you finish your studies, whichever comes first.\n\n3. The number and size of the instalments are settled with you by the committee, in the light of what you are earning.\n\n4. If you do not find work, or you fall ill, or you meet genuine hardship, come to the committee. Instalments can be deferred, and they can be forgiven. You will not be pursued.\n\n5. Keep the committee informed if your address, phone number or job changes.\n\n6. What you return goes back into this fund and pays for the next student from this village.\n\n7. This is not a court document. It is a promise made before Allah and before the people of your village. The committee will not take legal action against you.'),
  ('wazifa_grace_months_after_study', '6')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE wazifa_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wazifa_documents_admin ON wazifa_documents;
CREATE POLICY wazifa_documents_admin ON wazifa_documents FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));

DROP POLICY IF EXISTS wazifa_documents_own ON wazifa_documents;
CREATE POLICY wazifa_documents_own ON wazifa_documents FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                  WHERE a.id = wazifa_documents.application_id
                    AND s.portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM wazifa_applications a JOIN wazifa_students s ON s.id = a.student_id
                       WHERE a.id = wazifa_documents.application_id
                         AND s.portal_user_id = current_portal_user_id()));

REVOKE ALL ON wazifa_documents FROM anon;

-- Extends migration 213's sheet so the printed and on-screen views both carry
-- the documents and the agreement.
CREATE OR REPLACE FUNCTION wazifa_application_sheet(p_application_id uuid) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'application', to_jsonb(a),
    'student', (SELECT to_jsonb(s) FROM wazifa_students s WHERE s.id = a.student_id),
    'family', (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY f.created_at), '[]'::jsonb)
                 FROM wazifa_family_members f WHERE f.application_id = a.id),
    'academics', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.passing_year), '[]'::jsonb)
                    FROM wazifa_academic_records r WHERE r.application_id = a.id),
    'documents', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]'::jsonb)
                    FROM wazifa_documents d WHERE d.application_id = a.id),
    'verifications', (SELECT COALESCE(jsonb_agg(to_jsonb(v)), '[]'::jsonb)
                        FROM wazifa_verifications v WHERE v.application_id = a.id),
    'decision', (SELECT to_jsonb(x) FROM wazifa_decisions x
                  WHERE x.application_id = a.id ORDER BY x.created_at DESC LIMIT 1),
    'monthly_income', wazifa_monthly_income(a.id),
    'family_education_cost', wazifa_family_education_cost(a.id)
  ) FROM wazifa_applications a WHERE a.id = p_application_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
