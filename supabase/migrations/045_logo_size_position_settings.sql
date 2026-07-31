-- Migration 045: Logo size and vertical position settings, so the committee logo can
-- be resized and nudged up/down from Settings instead of being fixed at whatever size
-- it happened to be uploaded at.
INSERT INTO site_settings (key, value, description) VALUES
  ('invoice_logo_width', '56', 'Logo size in pixels on generated invoices/receipts'),
  ('invoice_logo_offset_y', '0', 'Vertical nudge (px, can be negative) for the logo on generated invoices/receipts')
ON CONFLICT (key) DO NOTHING;
