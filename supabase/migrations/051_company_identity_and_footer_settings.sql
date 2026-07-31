-- Migration 051: Company identity (name in both languages, email) and an expanded
-- invoice footer (complaint number, management team contacts, social/project links)
-- were hardcoded directly in ReceiptDocument.tsx. Moving them into site_settings so
-- the administrator can edit them without a code change — this is what actually
-- prints on generated bills, cash receipts, and payment vouchers.

INSERT INTO site_settings (key, value, description) VALUES
  ('company_name_en', 'Dhab Pari', 'Company/committee name shown on generated bills, receipts, and vouchers'),
  ('company_name_ur', 'واٹر اینڈ ویلفئیر کمیٹی', 'Company/committee name in Urdu — shown only when the display language setting is Urdu'),
  ('company_email', 'dhabpariwelfare@gmail.com', 'Contact email shown on generated bills, receipts, and vouchers'),
  ('footer_complaint_number', NULL, 'Complaint/support number shown in the invoice footer'),
  ('footer_management_contacts', '[]', 'JSON array of {name, designation, whatsapp} — management team shown in the invoice footer'),
  ('footer_facebook_link', NULL, 'Facebook page link shown in the invoice footer'),
  ('footer_whatsapp_group_link', NULL, 'WhatsApp community group link shown in the invoice footer'),
  ('footer_projects_link', NULL, 'Current projects page link shown in the invoice footer'),
  ('footer_donation_link', NULL, 'Donation page link shown in the invoice footer')
ON CONFLICT (key) DO NOTHING;
