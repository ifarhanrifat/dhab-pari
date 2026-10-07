-- CRITICAL SECURITY FIX: the 5 private Supabase Storage buckets flagged
-- last night as a known, deliberately-unfixed gap (donation_receipts,
-- bill_payment_proofs, wazifa_agreement_documents,
-- vehicle_registration_documents, city_purchase_attachments) had zero
-- tenant check on their READ/DELETE policies -- gated only by
-- can_access_system(...) (a check on the CALLER's own role, not on who
-- owns the file) or, on two of them, the even broader
-- `OR auth.role() = 'authenticated'`. That gap was judged non-exploitable
-- at the time because only one tenant existed. A second tenant now
-- exists, so it is live and real: any authenticated donors_projects-access
-- admin of ANY tenant could read/delete another tenant's actual uploaded
-- documents (payment proofs, CNIC/vehicle photos, wazifa agreements), as
-- long as they know or can obtain the file's storage path.
--
-- Storage objects have no tenant_id of their own, so the fix correlates
-- each object's path (storage.objects.name) against whichever real table
-- stores that path, requiring that row's tenant_id to match the caller's
-- own my_tenant_id(). This is added as an ADDITIONAL "AND exists(...)"
-- condition alongside each policy's existing permission logic, which is
-- otherwise left untouched -- same roles, same OR/AND structure as
-- before, just now also bounded to "a file that actually belongs to a
-- record in my own tenant".
--
-- donation_receipts is referenced by six different tables (one shared
-- bucket across donor pledges, kafalat, and sadqa flows) -- the EXISTS
-- below is a union across all six.

alter policy "Staff can read donation receipts" on storage.objects
  using (
    (bucket_id = 'donation_receipts'::text) and can_access_system('donors_projects'::character varying)
    and exists (
      select 1 from donors where payment_proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_disbursements where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_fee_payments where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_uniform_issues where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from pool_payments where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from sadqa_receipts where proof_url = storage.objects.name and tenant_id = my_tenant_id()
    )
  );

alter policy "Staff can delete donation receipts" on storage.objects
  using (
    (bucket_id = 'donation_receipts'::text) and can_access_system('donors_projects'::character varying)
    and exists (
      select 1 from donors where payment_proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_disbursements where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_fee_payments where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from kafalat_uniform_issues where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from pool_payments where proof_url = storage.objects.name and tenant_id = my_tenant_id()
      union all
      select 1 from sadqa_receipts where proof_url = storage.objects.name and tenant_id = my_tenant_id()
    )
  );

alter policy "Water staff can read bill payment proofs" on storage.objects
  using (
    (bucket_id = 'bill_payment_proofs'::text) and can_access_system('water_supply'::character varying)
    and exists (select 1 from bill_payment_claims where payment_proof_url = storage.objects.name and tenant_id = my_tenant_id())
  );

alter policy "Water staff can delete bill payment proofs" on storage.objects
  using (
    (bucket_id = 'bill_payment_proofs'::text) and can_access_system('water_supply'::character varying)
    and exists (select 1 from bill_payment_claims where payment_proof_url = storage.objects.name and tenant_id = my_tenant_id())
  );

alter policy "Donors staff can read wazifa agreement documents" on storage.objects
  using (
    (bucket_id = 'wazifa_agreement_documents'::text)
    and (can_access_system('donors_projects'::character varying) or (auth.role() = 'authenticated'::text))
    and exists (select 1 from wazifa_agreements where signed_document_url = storage.objects.name and tenant_id = my_tenant_id())
  );

alter policy "Donors staff can delete wazifa agreement documents" on storage.objects
  using (
    (bucket_id = 'wazifa_agreement_documents'::text) and can_access_system('donors_projects'::character varying)
    and exists (select 1 from wazifa_agreements where signed_document_url = storage.objects.name and tenant_id = my_tenant_id())
  );

alter policy "Committee can read vehicle registration documents" on storage.objects
  using (
    (bucket_id = 'vehicle_registration_documents'::text)
    and (can_access_system('donors_projects'::character varying) or (auth.role() = 'authenticated'::text))
    and exists (
      select 1 from vehicle_registration_requests
      where tenant_id = my_tenant_id()
        and (owner_id_card_url = storage.objects.name or license_url = storage.objects.name
             or vehicle_doc_url = storage.objects.name or driver_photo_url = storage.objects.name)
    )
  );

alter policy "Committee can delete vehicle registration documents" on storage.objects
  using (
    (bucket_id = 'vehicle_registration_documents'::text) and can_access_system('donors_projects'::character varying)
    and exists (
      select 1 from vehicle_registration_requests
      where tenant_id = my_tenant_id()
        and (owner_id_card_url = storage.objects.name or license_url = storage.objects.name
             or vehicle_doc_url = storage.objects.name or driver_photo_url = storage.objects.name)
    )
  );

alter policy "Authenticated can read city purchase attachments" on storage.objects
  using (
    (bucket_id = 'city_purchase_attachments'::text) and (auth.role() = 'authenticated'::text)
    and exists (
      select 1 from city_purchase_requests
      where tenant_id = my_tenant_id()
        and (item_attachment_path = storage.objects.name or bill_attachment_path = storage.objects.name)
    )
  );

alter policy "Admin can delete city purchase attachments" on storage.objects
  using (
    (bucket_id = 'city_purchase_attachments'::text) and current_admin_permission('manage_parties'::character varying)
    and exists (
      select 1 from city_purchase_requests
      where tenant_id = my_tenant_id()
        and (item_attachment_path = storage.objects.name or bill_attachment_path = storage.objects.name)
    )
  );
