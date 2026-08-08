-- Migration 158: donor-specific receipt/voucher footer content, separate
-- from the shared water_supply/global one — a donor_* row overrides its
-- shared counterpart only when set (fetchBrandingSettings('donors_projects')
-- picks donor_* first, falls back to the shared key otherwise), so nothing
-- changes for water_supply or for donor receipts until these are filled in
-- via the new "Donor Templates" section in Settings.
INSERT INTO site_settings (key, value, description) VALUES
  ('donor_invoice_template', NULL, 'Receipt template style for donor receipts — falls back to the shared Invoice Template if empty'),
  ('donor_helpline_numbers', NULL, 'Helpline number(s) shown on donor receipts — falls back to the shared Helpline Numbers if empty'),
  ('donor_invoice_instructions', NULL, 'Instructions text shown on donor receipts — falls back to the shared Instructions if empty'),
  ('donor_footer_complaint_number', NULL, 'Complaint/support number shown on donor receipts — falls back to the shared value if empty'),
  ('donor_footer_management_contacts', '[]', 'JSON array of {name, designation, whatsapp} shown on donor receipts — falls back to the shared Management Contacts if empty'),
  ('donor_footer_facebook_link', NULL, 'Facebook page link on donor receipts — falls back to the shared value if empty'),
  ('donor_footer_whatsapp_group_link', NULL, 'WhatsApp group link on donor receipts — falls back to the shared value if empty'),
  ('donor_footer_projects_link', NULL, 'Projects page link on donor receipts — falls back to the shared value if empty'),
  ('donor_footer_donation_link', NULL, 'Donation page link on donor receipts — falls back to the shared value if empty')
ON CONFLICT (key) DO NOTHING;
