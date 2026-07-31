-- Migration 031: Selectable invoice/receipt template setting.
INSERT INTO site_settings (key, value, description) VALUES
  ('invoice_template', 'classic', 'Visual template used when generating/printing bill and receipt documents (classic/modern/minimal/detailed/compact)')
ON CONFLICT (key) DO NOTHING;
