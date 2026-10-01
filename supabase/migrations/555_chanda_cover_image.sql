-- Migration 555: Chanda campaign cover image -- 2026-10-01.
--
-- Real ask: "can we run the progress bar and the images for the chanda
-- projects" -- the progress bar is pure client-side math (confirmed total /
-- target_amount, both already public via chanda_campaigns_public), but a
-- cover photo needs a real column since chanda_campaigns never had one.
ALTER TABLE chanda_campaigns ADD COLUMN cover_image_url text;

-- chanda_campaigns_public lists its columns explicitly (not SELECT *), so
-- the new column needs the view recreated to actually reach the public page.
DROP VIEW chanda_campaigns_public;
CREATE VIEW chanda_campaigns_public AS
SELECT id, type, directory_entry_id, title, title_ur, description, description_ur,
       target_amount, payment_method, account_number, account_title, bank_name, display_until,
       cover_image_url
FROM chanda_campaigns WHERE is_active = true AND display_until > now();
GRANT SELECT ON chanda_campaigns_public TO anon, authenticated;
