-- Migration 225: real money for Esal-e-Sawab — receipt, invoice, agreement,
-- and the asset the village ends up owning.
--
-- ═════════════════════════════════════════════════════════════════════════
-- The defect this replaces
-- ═════════════════════════════════════════════════════════════════════════
-- The admin screen walked the object through its statuses with a plain
--
--     supabase.from('sadqa_objects').update({ status: next })
--
-- so pressing "cash received" set a text column to 'funded' and did nothing
-- else. No voucher, no ledger row, no donation, not even amount_received_pkr.
-- A donor could see their offer marked as paid and then marked as purchased
-- while their own account showed no transaction at all, because there was
-- none. The committee's books said the same: nothing happened.
--
-- Status is now a consequence of money moving, never a substitute for it.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Why the estimate and the bill are two different numbers
-- ═════════════════════════════════════════════════════════════════════════
-- The catalogue says mosque fans cost Rs 30,000. The actual bill is whatever
-- the shop in Chakwal charges on the day. Pretending those are the same number
-- is what produces a register nobody trusts, so the donor is told before they
-- offer that the real bill will differ, the invoice is shown to them, both
-- sides agree it, and the difference lands in the donor's own ledger — a
-- credit if it came in cheaper, a debt if it came in dearer.

ALTER TABLE sadqa_objects
  -- capital_cost_pkr keeps its meaning: the estimate quoted up front.
  ADD COLUMN IF NOT EXISTS actual_cost_pkr decimal,
  ADD COLUMN IF NOT EXISTS donor_account_id uuid REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS asset_account_id uuid REFERENCES accounts(id),
  ADD COLUMN IF NOT EXISTS agreed_bill_id uuid,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_voucher_id uuid REFERENCES vouchers(id);

-- ── What the donor actually sent ─────────────────────────────────────────
-- Proof is not optional. The whole failure above was a status that could be
-- set without evidence, so the receipt carries the evidence or it is not a
-- receipt. Cash handed over in person has no screenshot, so that one case is
-- allowed through with a named witness instead — a person, not a blank.
CREATE TABLE IF NOT EXISTS sadqa_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES sadqa_objects(id) ON DELETE CASCADE,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  method varchar NOT NULL CHECK (method IN ('cash', 'bank', 'jazzcash', 'easypaisa')),
  received_on date NOT NULL DEFAULT current_date,
  proof_url text,
  cash_witness varchar,
  donor_id uuid REFERENCES donors(id) ON DELETE SET NULL,
  note text,
  recorded_by uuid REFERENCES admin_users(id),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT sadqa_receipts_needs_evidence CHECK (
    proof_url IS NOT NULL OR (method = 'cash' AND cash_witness IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS sadqa_receipts_object_idx ON sadqa_receipts(object_id);

-- ── The conversation ─────────────────────────────────────────────────────
-- Quotations, photographs of the shop's bill, "can we get a better one for
-- five thousand more". This is where a price is agreed, so it is a record of
-- the agreement rather than a chat that can be cleared.
CREATE TABLE IF NOT EXISTS sadqa_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES sadqa_objects(id) ON DELETE CASCADE,
  sender_kind varchar NOT NULL CHECK (sender_kind IN ('donor', 'committee')),
  portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  sender_name varchar,
  body text,
  attachment_url text,
  attachment_kind varchar CHECK (attachment_kind IN ('quotation', 'invoice', 'receipt', 'photo', 'other')),
  -- Set on the message a bill announcement generates, so the thread reads as
  -- a history of offers rather than prose with numbers hidden in it.
  bill_id uuid,
  is_system boolean NOT NULL DEFAULT false,
  read_by_donor_at timestamptz,
  read_by_committee_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CHECK (body IS NOT NULL OR attachment_url IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS sadqa_messages_object_idx ON sadqa_messages(object_id, created_at);

-- ── The bill both sides sign off ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sadqa_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES sadqa_objects(id) ON DELETE CASCADE,
  vendor_name varchar NOT NULL,
  bill_no varchar,
  bill_date date,
  amount_pkr decimal NOT NULL CHECK (amount_pkr > 0),
  invoice_url text,
  note text,
  status varchar NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'agreed', 'rejected', 'superseded')),
  proposed_by uuid REFERENCES admin_users(id),
  agreed_by_portal_user_id uuid REFERENCES portal_users(id),
  agreed_by_admin_user_id uuid REFERENCES admin_users(id),
  agreed_at timestamptz,
  rejected_reason text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sadqa_bills_object_idx ON sadqa_bills(object_id, status);

ALTER TABLE sadqa_objects
  ADD CONSTRAINT sadqa_objects_agreed_bill_fkey
  FOREIGN KEY (agreed_bill_id) REFERENCES sadqa_bills(id) ON DELETE SET NULL;

ALTER TABLE sadqa_messages
  ADD CONSTRAINT sadqa_messages_bill_fkey
  FOREIGN KEY (bill_id) REFERENCES sadqa_bills(id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- Where the object lands in the chart of accounts
-- ═════════════════════════════════════════════════════════════════════════
-- Migration 210 already says what this thing is: "a committee-held waqf asset
-- permanently attributed to the named person". So it belongs in assets, under
-- its own name, not written off to an expense line the year it was bought. A
-- village that has bought forty water coolers over ten years should be able to
-- open the accounts and see forty water coolers.
INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected) VALUES
  ('DP-2005', 'Sadqa-e-Jariya Assets Donated', 'صدقہ جاریہ عطیہ شدہ اثاثے', 'income', 'donors_projects',
   'Donated capital recognised when a sadqa-e-jariya object is acquired. The matching debit is the asset itself.',
   true)
ON CONFLICT (code, system) DO NOTHING;

-- One account per object, named after the object, so the asset register reads
-- like the village: "Mosque fans and cooling — Jamia Masjid", not "DP-4001".
CREATE OR REPLACE FUNCTION ensure_sadqa_asset_account(p_object_id uuid) RETURNS uuid AS $$
DECLARE o sadqa_objects%ROWTYPE; v_id uuid; v_code varchar; v_name varchar;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF o.asset_account_id IS NOT NULL THEN RETURN o.asset_account_id; END IF;

  v_code := 'SJA-' || o.object_no;
  v_name := o.item_name
    || CASE WHEN COALESCE(o.approved_location, o.proposed_location) IS NOT NULL
            THEN ' — ' || COALESCE(o.approved_location, o.proposed_location) ELSE '' END;

  SELECT id INTO v_id FROM accounts WHERE code = v_code AND system = 'donors_projects';
  IF v_id IS NULL THEN
    INSERT INTO accounts (code, name, name_ur, type, system, description, is_protected)
    VALUES (v_code, v_name, o.item_name_ur, 'asset', 'donors_projects',
            'Sadqa-e-Jariya, dedicated to ' || o.dedicated_to || '. Waqf — held by the committee as mutawalli.',
            true)
    RETURNING id INTO v_id;
  END IF;

  UPDATE sadqa_objects SET asset_account_id = v_id, updated_at = now() WHERE id = p_object_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION ensure_sadqa_asset_account(uuid) TO authenticated;

ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS vouchers_voucher_type_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_voucher_type_check
  CHECK (voucher_type IN ('expense', 'income', 'contra', 'withdrawal', 'deposit',
    'security_deposit', 'security_deposit_refund', 'advance', 'advance_settlement',
    'complaint_waiver', 'project_transfer',
    'zakat_disbursement', 'ushr_disbursement', 'esal_e_sawab',
    'kafalat_payment', 'wazifa_payment', 'wazifa_repayment', 'wazifa_contribution',
    'pool_shortfall_cover', 'sadqa_asset', 'sadqa_refund'));

INSERT INTO voucher_counters (system, voucher_type, prefix) VALUES
  ('donors_projects', 'sadqa_asset', 'DP-SJA-V'),
  ('donors_projects', 'sadqa_refund', 'DP-SJR-V')
ON CONFLICT (system, voucher_type) DO NOTHING;

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS sadqa_object_id uuid REFERENCES sadqa_objects(id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- Money in
-- ═════════════════════════════════════════════════════════════════════════
-- Recorded as an ordinary verified donation, which is what it is, so the
-- existing trigger posts Dr cash/bank, Cr the donor's own account and a memo
-- credit to the Esal-e-Sawab fund. The donor's ledger shows it immediately,
-- under their own name, because it really happened.
CREATE OR REPLACE FUNCTION sadqa_record_receipt(
  p_object_id uuid, p_amount decimal, p_method varchar,
  p_proof_url text DEFAULT NULL, p_cash_witness varchar DEFAULT NULL,
  p_received_on date DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  o sadqa_objects%ROWTYPE; v_donor_id uuid; v_account_id uuid; v_total decimal;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.status IN ('proposed', 'declined') THEN
    RAISE EXCEPTION 'Approve this offer before recording money against it.' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter the amount actually received.' USING ERRCODE = 'P0001';
  END IF;
  IF p_proof_url IS NULL AND NOT (p_method = 'cash' AND COALESCE(trim(p_cash_witness), '') <> '') THEN
    RAISE EXCEPTION
      'Attach the transfer screenshot or slip. For cash handed over in person, name the person who witnessed it.'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO donors (name, name_ur, phone, amount_pkr, date, is_verified, payment_method,
                      is_anonymous, fund_type, portal_user_id, payment_status,
                      payment_proof_url, notes, submitted_via)
  VALUES (o.donor_name, o.donor_name_ur, o.donor_phone, p_amount,
          COALESCE(p_received_on, (now() AT TIME ZONE 'Asia/Karachi')::date), true, p_method,
          o.donor_is_anonymous, 'esal_e_sawab', o.portal_user_id, 'paid', p_proof_url,
          'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ')'
            || COALESCE(' · ' || p_note, ''),
          'staff')
  RETURNING id INTO v_donor_id;

  INSERT INTO sadqa_receipts (object_id, amount_pkr, method, received_on, proof_url,
                              cash_witness, donor_id, note, recorded_by)
  VALUES (p_object_id, p_amount, p_method,
          COALESCE(p_received_on, (now() AT TIME ZONE 'Asia/Karachi')::date),
          p_proof_url, p_cash_witness, v_donor_id, p_note, current_admin_user_id());

  -- The generic donation trigger labels every restricted gift "Donation
  -- (ESAL_E_SAWAB)", which tells the donor nothing about which object it was
  -- for. Their statement should name the thing they paid for, in the same
  -- words as the settlement line that follows it.
  UPDATE ledger_entries
     SET particular = 'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ') · received'
   WHERE reference_type = 'donation' AND reference_id = v_donor_id;

  v_account_id := ensure_donor_account(o.donor_name, o.donor_phone);
  SELECT COALESCE(SUM(amount_pkr), 0) INTO v_total FROM sadqa_receipts WHERE object_id = p_object_id;

  UPDATE sadqa_objects
     SET amount_received_pkr = v_total,
         donor_account_id = COALESCE(donor_account_id, v_account_id),
         -- Only the money changes the status, and only once enough of it has
         -- arrived to buy the thing.
         status = CASE WHEN status = 'approved' AND v_total >= capital_cost_pkr
                       THEN 'funded' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id;

  PERFORM sadqa_system_message(p_object_id,
    'Received Rs ' || trim(to_char(p_amount, 'FM999,999,990')) || ' — thank you.');

  RETURN jsonb_build_object('received', p_amount, 'total_received', v_total,
                            'donor_id', v_donor_id, 'donor_account_id', v_account_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- The conversation
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sadqa_system_message(p_object_id uuid, p_body text, p_bill_id uuid DEFAULT NULL)
RETURNS uuid AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO sadqa_messages (object_id, sender_kind, sender_name, body, is_system, bill_id,
                              admin_user_id)
  VALUES (p_object_id, 'committee', 'Committee', p_body, true, p_bill_id, current_admin_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION sadqa_post_message(
  p_object_id uuid, p_body text DEFAULT NULL,
  p_attachment_url text DEFAULT NULL, p_attachment_kind varchar DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_admin uuid; v_portal uuid; v_kind varchar; v_name varchar; v_id uuid;
BEGIN
  v_admin := current_admin_user_id();
  v_portal := current_portal_user_id();

  IF v_admin IS NOT NULL THEN
    v_kind := 'committee';
    SELECT full_name INTO v_name FROM admin_users WHERE id = v_admin;
  ELSIF v_portal IS NOT NULL
    AND EXISTS (SELECT 1 FROM sadqa_objects WHERE id = p_object_id AND portal_user_id = v_portal) THEN
    v_kind := 'donor';
    SELECT full_name INTO v_name FROM portal_users WHERE id = v_portal;
  ELSE
    RAISE EXCEPTION 'Not authorized to write on this request.' USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(trim(p_body), '') = '' AND p_attachment_url IS NULL THEN
    RAISE EXCEPTION 'Write something or attach a file.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO sadqa_messages (object_id, sender_kind, portal_user_id, admin_user_id,
                              sender_name, body, attachment_url, attachment_kind)
  VALUES (p_object_id, v_kind, CASE WHEN v_kind = 'donor' THEN v_portal END,
          CASE WHEN v_kind = 'committee' THEN v_admin END,
          v_name, nullif(trim(p_body), ''), p_attachment_url, p_attachment_kind)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'sender_kind', v_kind);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION sadqa_thread(p_object_id uuid) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', m.id, 'sender_kind', m.sender_kind, 'sender_name', m.sender_name,
    'body', m.body, 'attachment_url', m.attachment_url, 'attachment_kind', m.attachment_kind,
    'is_system', m.is_system, 'bill_id', m.bill_id, 'created_at', m.created_at,
    'bill', CASE WHEN m.bill_id IS NULL THEN NULL ELSE
      (SELECT jsonb_build_object('id', b.id, 'vendor_name', b.vendor_name, 'bill_no', b.bill_no,
                                 'amount_pkr', b.amount_pkr, 'invoice_url', b.invoice_url,
                                 'status', b.status)
         FROM sadqa_bills b WHERE b.id = m.bill_id) END
  ) ORDER BY m.created_at), '[]'::jsonb)
  FROM sadqa_messages m
  WHERE m.object_id = p_object_id
    AND (current_admin_user_id() IS NOT NULL
         OR EXISTS (SELECT 1 FROM sadqa_objects o
                     WHERE o.id = p_object_id AND o.portal_user_id = current_portal_user_id()));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- The bill, and agreeing it
-- ═════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sadqa_propose_bill(
  p_object_id uuid, p_vendor varchar, p_amount decimal,
  p_bill_no varchar DEFAULT NULL, p_bill_date date DEFAULT NULL,
  p_invoice_url text DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE o sadqa_objects%ROWTYPE; v_id uuid; v_diff decimal; v_msg text;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'This object has already been settled.' USING ERRCODE = 'P0001';
  END IF;

  -- An earlier offer stops being live the moment a new one is made.
  UPDATE sadqa_bills SET status = 'superseded'
   WHERE object_id = p_object_id AND status = 'proposed';

  INSERT INTO sadqa_bills (object_id, vendor_name, bill_no, bill_date, amount_pkr,
                           invoice_url, note, proposed_by)
  VALUES (p_object_id, p_vendor, p_bill_no, p_bill_date, p_amount, p_invoice_url, p_note,
          current_admin_user_id())
  RETURNING id INTO v_id;

  v_diff := p_amount - o.capital_cost_pkr;
  v_msg := 'Bill from ' || p_vendor || ': Rs ' || trim(to_char(p_amount, 'FM999,999,990')) || '. '
    || CASE
         WHEN v_diff > 0 THEN 'That is Rs ' || trim(to_char(v_diff, 'FM999,999,990'))
              || ' more than the estimate, so that much will show as due on your account.'
         WHEN v_diff < 0 THEN 'That is Rs ' || trim(to_char(-v_diff, 'FM999,999,990'))
              || ' less than the estimate, so that much stays to your credit.'
         ELSE 'Exactly the estimate.' END;

  PERFORM sadqa_system_message(p_object_id, v_msg, v_id);
  RETURN jsonb_build_object('bill_id', v_id, 'amount', p_amount, 'difference', v_diff);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Agreed by the donor from their portal, or by the committee on their behalf
-- when the donor has said yes on the phone — in which case whose decision it
-- was is recorded, rather than the committee quietly agreeing with itself.
CREATE OR REPLACE FUNCTION sadqa_agree_bill(p_bill_id uuid, p_method varchar DEFAULT 'bank')
RETURNS jsonb AS $$
DECLARE
  b sadqa_bills%ROWTYPE; o sadqa_objects%ROWTYPE;
  v_portal uuid; v_admin uuid;
BEGIN
  SELECT * INTO b FROM sadqa_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF b.status <> 'proposed' THEN
    RAISE EXCEPTION 'This bill is no longer open for agreement.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = b.object_id;

  v_admin := current_admin_user_id();
  v_portal := current_portal_user_id();
  IF v_admin IS NULL AND (v_portal IS NULL OR o.portal_user_id IS DISTINCT FROM v_portal) THEN
    RAISE EXCEPTION 'Not authorized to agree this bill.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_bills
     SET status = 'agreed', agreed_at = now(),
         agreed_by_portal_user_id = CASE WHEN v_admin IS NULL THEN v_portal END,
         agreed_by_admin_user_id = v_admin
   WHERE id = p_bill_id;

  UPDATE sadqa_objects SET agreed_bill_id = p_bill_id, actual_cost_pkr = b.amount_pkr,
                           updated_at = now()
   WHERE id = b.object_id;

  RETURN sadqa_settle_object(b.object_id, p_method);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION sadqa_reject_bill(p_bill_id uuid, p_reason text) RETURNS jsonb AS $$
DECLARE b sadqa_bills%ROWTYPE; o sadqa_objects%ROWTYPE; v_portal uuid;
BEGIN
  SELECT * INTO b FROM sadqa_bills WHERE id = p_bill_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = b.object_id;
  v_portal := current_portal_user_id();
  IF current_admin_user_id() IS NULL AND (v_portal IS NULL OR o.portal_user_id IS DISTINCT FROM v_portal) THEN
    RAISE EXCEPTION 'Not authorized.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE sadqa_bills SET status = 'rejected', rejected_reason = p_reason WHERE id = p_bill_id;
  PERFORM sadqa_post_message(b.object_id, 'I would like to discuss this bill: ' || COALESCE(p_reason, ''));
  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ═════════════════════════════════════════════════════════════════════════
-- Settlement — the entry the whole feature exists to produce
-- ═════════════════════════════════════════════════════════════════════════
-- Two balanced pairs.
--
--   Dr  Asset (this object, by name)     bill      the village now owns it
--   Cr  Cash / Bank                      bill      the vendor was paid
--
--   Dr  Donor's own account              bill      their money was applied
--   Cr  Sadqa-e-Jariya Assets Donated    bill      donated capital recognised
--
-- The donor's balance is then simply what they gave less what it cost. Sent
-- 30,000 against a 27,500 bill and 2,500 stays to their credit; sent 30,000
-- against a 33,000 bill and 3,000 shows as due from them. Nothing has to be
-- calculated in a screen and hoped to match the ledger — it is the ledger.
CREATE OR REPLACE FUNCTION sadqa_settle_object(p_object_id uuid, p_method varchar DEFAULT 'bank')
RETURNS jsonb AS $$
DECLARE
  o sadqa_objects%ROWTYPE;
  v_asset uuid; v_cash uuid; v_donated uuid; v_donor_acct uuid;
  v_voucher_id uuid; v_voucher_no varchar; v_amount decimal; v_balance decimal;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE = 'P0001'; END IF;
  IF o.settled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Already settled.' USING ERRCODE = 'P0001';
  END IF;
  v_amount := o.actual_cost_pkr;
  IF COALESCE(v_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'Agree a bill before settling.' USING ERRCODE = 'P0001';
  END IF;

  v_asset := ensure_sadqa_asset_account(p_object_id);
  v_donor_acct := COALESCE(o.donor_account_id, ensure_donor_account(o.donor_name, o.donor_phone));
  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);
  SELECT id INTO v_donated FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2005';

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, sadqa_object_id, fund_type)
  VALUES ('donors_projects', 'sadqa_asset', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || '), dedicated to '
      || o.dedicated_to || ' · bill '
      || COALESCE((SELECT COALESCE(bill_no, vendor_name) FROM sadqa_bills WHERE id = o.agreed_bill_id), ''),
    v_amount, v_cash, v_asset, o.donor_name, p_object_id, 'esal_e_sawab')
  RETURNING id, voucher_no INTO v_voucher_id, v_voucher_no;

  UPDATE sadqa_objects
     SET settled_at = now(), settlement_voucher_id = v_voucher_id,
         status = CASE WHEN status IN ('approved', 'funded') THEN 'procured' ELSE status END,
         updated_at = now()
   WHERE id = p_object_id;

  SELECT COALESCE(SUM(credit - debit), 0) INTO v_balance
    FROM ledger_entries WHERE account_id = v_donor_acct;

  PERFORM sadqa_system_message(p_object_id,
    'Bill agreed and posted as ' || v_voucher_no || '. '
    || CASE WHEN v_balance > 0 THEN 'Rs ' || trim(to_char(v_balance, 'FM999,999,990'))
                                    || ' remains to your credit.'
            WHEN v_balance < 0 THEN 'Rs ' || trim(to_char(-v_balance, 'FM999,999,990'))
                                    || ' is now due from you.'
            ELSE 'Your account is exactly settled.' END);

  RETURN jsonb_build_object('voucher_no', v_voucher_no, 'amount', v_amount,
                            'donor_balance', v_balance,
                            'asset_account', (SELECT code FROM accounts WHERE id = v_asset));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The legs ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION post_sadqa_asset_legs(p_voucher vouchers) RETURNS void AS $$
DECLARE
  o sadqa_objects%ROWTYPE; v_donor_acct uuid; v_donated uuid; v_fund uuid; v_particular text;
BEGIN
  SELECT * INTO o FROM sadqa_objects WHERE id = p_voucher.sadqa_object_id;
  v_particular := p_voucher.particular;
  v_donor_acct := o.donor_account_id;
  SELECT id INTO v_donated FROM accounts WHERE system = 'donors_projects' AND code = 'DP-2005';
  v_fund := fund_account_id('esal_e_sawab');

  -- The village owns it; the vendor was paid.
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (p_voucher.to_account_id, p_voucher.voucher_date, v_particular,
          p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
  INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
  VALUES (p_voucher.from_account_id, p_voucher.voucher_date, v_particular,
          0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);

  -- Their money applied; the donated capital recognised. The label is the one
  -- the donor will look for on their statement.
  IF v_donor_acct IS NOT NULL AND v_donated IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_donor_acct, p_voucher.voucher_date,
            'Sadqa-e-Jariya — ' || o.item_name || ' (' || o.object_no || ')',
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_donated, p_voucher.voucher_date, v_particular,
            0, p_voucher.amount_pkr, 'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;

  -- The restricted fund is drawn down by what was spent out of it.
  IF v_fund IS NOT NULL THEN
    INSERT INTO ledger_entries (account_id, entry_date, particular, debit, credit, reference_type, reference_id, receipt_no)
    VALUES (v_fund, p_voucher.voucher_date, v_particular,
            p_voucher.amount_pkr, 0, 'voucher', p_voucher.id, p_voucher.receipt_no);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Refunding a donor's leftover credit, when they ask for it back rather than
-- leaving it against the next thing.
CREATE OR REPLACE FUNCTION sadqa_refund_balance(
  p_object_id uuid, p_amount decimal, p_method varchar DEFAULT 'bank', p_note text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  o sadqa_objects%ROWTYPE; v_cash uuid; v_balance decimal; v_no varchar;
BEGIN
  IF NOT COALESCE(current_admin_permission('post_transactions'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO o FROM sadqa_objects WHERE id = p_object_id;
  IF o.donor_account_id IS NULL THEN
    RAISE EXCEPTION 'This donor has no account yet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(SUM(credit - debit), 0) INTO v_balance
    FROM ledger_entries WHERE account_id = o.donor_account_id;
  IF p_amount > v_balance THEN
    RAISE EXCEPTION 'Only Rs % is to their credit.',
      trim(to_char(v_balance, 'FM999,999,990')) USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_cash FROM accounts WHERE system = 'donors_projects'
     AND code = (CASE WHEN p_method = 'cash' THEN 'DP-1001' ELSE 'DP-1002' END);

  INSERT INTO vouchers (system, voucher_type, voucher_date, particular, amount_pkr,
    from_account_id, to_account_id, party_name, sadqa_object_id, fund_type)
  VALUES ('donors_projects', 'sadqa_refund', (now() AT TIME ZONE 'Asia/Karachi')::date,
    'Sadqa-e-Jariya — returned to ' || o.donor_name || ' (' || o.object_no || ')'
      || COALESCE(' · ' || p_note, ''),
    p_amount, v_cash, o.donor_account_id, o.donor_name, p_object_id, 'esal_e_sawab')
  RETURNING voucher_no INTO v_no;
  RETURN jsonb_build_object('voucher_no', v_no, 'amount', p_amount);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── The dispatcher, made thin ────────────────────────────────────────────
-- Migrations 218 and 222 each re-declared the whole ninety-line body just to
-- add one branch, which is how a transcription error eventually gets in. The
-- existing body is renamed instead of retyped — the rename carries it across
-- exactly — and from here a new voucher type adds a branch to the short
-- function below and nothing else.
--
-- A refund is the plain "debit the party, credit the cash" the generic path
-- already handles, so it needs no branch of its own.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'post_voucher_ledger_legs_base') THEN
    ALTER FUNCTION post_voucher_ledger_legs(vouchers) RENAME TO post_voucher_ledger_legs_base;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION post_voucher_ledger_legs(p_voucher vouchers) RETURNS void AS $$
BEGIN
  -- A reversal mirrors whatever the original posted, so it must fall through
  -- to the base rather than be re-derived from the voucher type.
  IF p_voucher.reverses_voucher_id IS NULL THEN
    IF p_voucher.voucher_type = 'sadqa_asset' THEN
      PERFORM post_sadqa_asset_legs(p_voucher);
      RETURN;
    END IF;
  END IF;
  PERFORM post_voucher_ledger_legs_base(p_voucher);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION post_voucher_ledger_legs(vouchers) TO authenticated;
GRANT EXECUTE ON FUNCTION post_voucher_ledger_legs_base(vouchers) TO authenticated;

-- ── What the donor sees ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION my_sadqa_objects() RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', o.id, 'object_no', o.object_no, 'item_name', o.item_name, 'item_name_ur', o.item_name_ur,
    'dedicated_to', o.dedicated_to, 'status', o.status,
    'estimated_cost', o.capital_cost_pkr, 'actual_cost', o.actual_cost_pkr,
    'received', o.amount_received_pkr,
    'annual_running_cost', o.annual_running_cost_pkr,
    'maintenance_mode', o.maintenance_mode,
    'settled', o.settled_at IS NOT NULL,
    'asset_account', (SELECT code FROM accounts WHERE id = o.asset_account_id),
    -- The number that answers "so where do I stand?" without arithmetic.
    'account_balance', COALESCE((SELECT SUM(credit - debit) FROM ledger_entries
                                  WHERE account_id = o.donor_account_id), 0),
    'open_bill', (SELECT jsonb_build_object('id', b.id, 'vendor_name', b.vendor_name,
                    'amount_pkr', b.amount_pkr, 'invoice_url', b.invoice_url, 'bill_no', b.bill_no)
                    FROM sadqa_bills b WHERE b.object_id = o.id AND b.status = 'proposed'
                   ORDER BY b.created_at DESC LIMIT 1),
    'unread', (SELECT count(*) FROM sadqa_messages m
                WHERE m.object_id = o.id AND m.sender_kind = 'committee' AND m.read_by_donor_at IS NULL),
    'created_at', o.created_at
  ) ORDER BY o.created_at DESC), '[]'::jsonb)
  FROM sadqa_objects o WHERE o.portal_user_id = current_portal_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ── Permissions ──────────────────────────────────────────────────────────
ALTER TABLE sadqa_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sadqa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sadqa_bills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sadqa_receipts_admin ON sadqa_receipts;
CREATE POLICY sadqa_receipts_admin ON sadqa_receipts FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
DROP POLICY IF EXISTS sadqa_receipts_own ON sadqa_receipts;
CREATE POLICY sadqa_receipts_own ON sadqa_receipts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_receipts.object_id
                   AND o.portal_user_id = current_portal_user_id()));

DROP POLICY IF EXISTS sadqa_messages_admin ON sadqa_messages;
CREATE POLICY sadqa_messages_admin ON sadqa_messages FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
DROP POLICY IF EXISTS sadqa_messages_own ON sadqa_messages;
CREATE POLICY sadqa_messages_own ON sadqa_messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_messages.object_id
                   AND o.portal_user_id = current_portal_user_id()));
DROP POLICY IF EXISTS sadqa_messages_mark_read ON sadqa_messages;
CREATE POLICY sadqa_messages_mark_read ON sadqa_messages FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_messages.object_id
                   AND o.portal_user_id = current_portal_user_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_messages.object_id
                        AND o.portal_user_id = current_portal_user_id()));

DROP POLICY IF EXISTS sadqa_bills_admin ON sadqa_bills;
CREATE POLICY sadqa_bills_admin ON sadqa_bills FOR ALL TO authenticated
  USING (can_access_system('donors_projects')) WITH CHECK (can_access_system('donors_projects'));
DROP POLICY IF EXISTS sadqa_bills_own ON sadqa_bills;
CREATE POLICY sadqa_bills_own ON sadqa_bills FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM sadqa_objects o WHERE o.id = sadqa_bills.object_id
                   AND o.portal_user_id = current_portal_user_id()));

REVOKE ALL ON sadqa_receipts, sadqa_messages, sadqa_bills FROM anon;

REVOKE ALL ON FUNCTION sadqa_record_receipt(uuid, decimal, varchar, text, varchar, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_propose_bill(uuid, varchar, decimal, varchar, date, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_agree_bill(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_reject_bill(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_settle_object(uuid, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_refund_balance(uuid, decimal, varchar, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_post_message(uuid, text, text, varchar) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION sadqa_thread(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION my_sadqa_objects() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION sadqa_record_receipt(uuid, decimal, varchar, text, varchar, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_propose_bill(uuid, varchar, decimal, varchar, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_agree_bill(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_reject_bill(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_settle_object(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_refund_balance(uuid, decimal, varchar, text) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_post_message(uuid, text, text, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_thread(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION my_sadqa_objects() TO authenticated;
GRANT EXECUTE ON FUNCTION sadqa_system_message(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION post_sadqa_asset_legs(vouchers) TO authenticated;
