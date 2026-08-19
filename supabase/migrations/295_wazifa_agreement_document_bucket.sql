-- Migration 295: storage for the signed, witnessed agreement document —
-- same private-bucket shape every other proof upload in this app
-- already uses (migration 116/128).

INSERT INTO storage.buckets (id, name, public) VALUES ('wazifa_agreement_documents', 'wazifa_agreement_documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Portal users can upload wazifa agreement documents" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'wazifa_agreement_documents' AND auth.role() = 'authenticated');
CREATE POLICY "Donors staff can read wazifa agreement documents" ON storage.objects FOR SELECT
  USING (bucket_id = 'wazifa_agreement_documents' AND (can_access_system('donors_projects') OR auth.role() = 'authenticated'));
CREATE POLICY "Donors staff can delete wazifa agreement documents" ON storage.objects FOR DELETE
  USING (bucket_id = 'wazifa_agreement_documents' AND can_access_system('donors_projects'));
