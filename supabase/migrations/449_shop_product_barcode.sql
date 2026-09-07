-- Real barcode support, replacing the fragile "show Gemini a numbered
-- text list and ask it to guess" match used at counter-sale time
-- (scan-sale-item) whenever a product actually has one. A barcode read
-- is an exact, deterministic lookup — no AI call, no confidence
-- threshold, no risk of picking the wrong flavor.
--
-- Deliberately NOT pre-seeded with real UPC/EAN codes for the static
-- PRODUCT_CATALOG reference data (productCatalog.ts) — that would mean
-- fabricating barcode numbers with no way to verify them against the
-- actual physical packaging, which is worse than no data at all. A
-- barcode only ever gets recorded here the moment a real shopkeeper
-- scans (or a committee member enters) the real physical code, so
-- every value in this column is something someone actually read off a
-- real product.
--
-- Partial unique index (not a plain column constraint) because most
-- rows will have barcode = null for a long while — packaged goods
-- already in a shop's catalog before this feature existed, and every
-- loose/khula good, which never has a barcode at all. A plain unique
-- index treats every null as distinct already, but being explicit
-- about "only when barcode is set" documents that intent.
alter table shop_products add column if not exists barcode text;

create unique index if not exists shop_products_barcode_per_shop_idx
  on shop_products (shop_id, barcode) where barcode is not null;
