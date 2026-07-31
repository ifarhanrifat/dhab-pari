-- Migration 033: Settings needed for the invoice — logo, signature, and helpline
-- numbers shown on the printed/shared document.
INSERT INTO site_settings (key, value, description) VALUES
  ('invoice_logo_url', NULL, 'Committee logo shown on generated invoices'),
  ('invoice_signature_url', NULL, 'Authorized signatory signature image shown on generated invoices'),
  ('helpline_numbers', NULL, 'Helpline / support numbers shown in the invoice footer'),
  ('invoice_instructions', NULL, 'Standard instructions/notes printed on every invoice')
ON CONFLICT (key) DO NOTHING;
