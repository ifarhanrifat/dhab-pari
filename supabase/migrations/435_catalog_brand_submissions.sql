-- Migration 435: "نیا برانڈ شامل کریں" (brand builder, design spec §3) —
-- for a brand genuinely missing from PRODUCT_CATALOG (src/lib/
-- productCatalog.ts). A shopkeeper fills in the brand name (+ Latin/
-- Urdu) and its items/variants; submitting does two things at once,
-- matching the design's own "listed_locally immediately, queued for
-- review" split:
--   1. Real shop_products rows go into the SUBMITTING SHOP's own
--      catalog right away — no waiting on anyone.
--   2. A catalog_brand_submissions row records what was submitted, for
--      committee review.
--
-- Deliberately scoped narrower than the design's full promise for
-- tonight: PRODUCT_CATALOG is a static TS file (src/lib/
-- productCatalog.ts), read into CATALOG_INDEX once at module load —
-- there is no live mechanism yet for an approved submission to actually
-- join every OTHER shop's Add Stock browsing without either a code
-- deploy (someone adding it to productCatalog.ts by hand) or a real
-- catalog-overlay read path merged into getCatalogForShopType at
-- request time. That merge is real, follow-up work — flagged here, not
-- silently skipped. What ships tonight: instant self-service for the
-- submitting shop (the actual pain point — "the catalog doesn't have my
-- brand") plus a real, durable review record for the committee to act
-- on, rather than the submission going nowhere.

CREATE TABLE IF NOT EXISTS catalog_brand_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  submitted_by_portal_user_id uuid REFERENCES portal_users(id),
  brand_name varchar NOT NULL,
  brand_name_ur varchar,
  category varchar NOT NULL,
  items jsonb NOT NULL, -- [{name, name_ur, flavor, flavor_ur, cost_price_pkr, unit_price_pkr}]
  status varchar NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_admin_id uuid REFERENCES admin_users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS catalog_brand_submissions_shop_id_idx ON catalog_brand_submissions(shop_id);
CREATE INDEX IF NOT EXISTS catalog_brand_submissions_status_idx ON catalog_brand_submissions(status);

ALTER TABLE catalog_brand_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "catalog_brand_submissions_owner_read" ON catalog_brand_submissions FOR SELECT TO authenticated
  USING (
    current_admin_permission('manage_parties')
    OR EXISTS (SELECT 1 FROM shops s WHERE s.id = shop_id AND s.portal_user_id = current_portal_user_id())
  );
-- No direct INSERT/UPDATE policy — writes only happen through the two
-- SECURITY DEFINER RPCs below, so a submission's shop_products rows and
-- its review record can never drift apart.

CREATE OR REPLACE FUNCTION submit_catalog_brand(
  p_shop_id uuid, p_brand_name text, p_brand_name_ur text, p_category text, p_items jsonb
) RETURNS uuid AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
  v_submission_id uuid;
  item jsonb;
  v_name text; v_name_ur text; v_flavor text; v_flavor_ur text;
  v_cost decimal; v_sale decimal;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in required.' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop_id AND portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You do not manage this shop.' USING ERRCODE = 'P0001';
  END IF;
  IF p_brand_name IS NULL OR trim(p_brand_name) = '' THEN RAISE EXCEPTION 'Brand name is required.' USING ERRCODE = 'P0001'; END IF;
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'Add at least one item.' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO catalog_brand_submissions (shop_id, submitted_by_portal_user_id, brand_name, brand_name_ur, category, items)
  VALUES (p_shop_id, v_portal_user_id, trim(p_brand_name), NULLIF(trim(COALESCE(p_brand_name_ur, '')), ''), p_category, p_items)
  RETURNING id INTO v_submission_id;

  -- "Listed locally" — real shop_products rows for THIS shop, right now,
  -- same insert shape ShopCatalogSection's own commit() uses.
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_name := item->>'name'; v_name_ur := NULLIF(item->>'name_ur', '');
    v_flavor := NULLIF(item->>'flavor', ''); v_flavor_ur := NULLIF(item->>'flavor_ur', '');
    v_cost := COALESCE((item->>'cost_price_pkr')::decimal, 0);
    v_sale := COALESCE((item->>'unit_price_pkr')::decimal, 0);
    IF v_name IS NULL OR trim(v_name) = '' THEN CONTINUE; END IF;

    INSERT INTO shop_products (shop_id, name, name_ur, company, category, flavor, flavor_ur, cost_price_pkr, unit_price_pkr, quantity_on_hand, is_active)
    VALUES (p_shop_id, trim(v_name), v_name_ur, trim(p_brand_name), p_category, v_flavor, v_flavor_ur, v_cost, v_sale, 0, true);
  END LOOP;

  RETURN v_submission_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION submit_catalog_brand(uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION submit_catalog_brand(uuid, text, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION review_catalog_brand_submission(p_submission_id uuid, p_approve boolean, p_note text) RETURNS void AS $$
BEGIN
  IF NOT COALESCE(current_admin_permission('manage_parties'), false) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  UPDATE catalog_brand_submissions
  SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      reviewed_by_admin_id = current_admin_user_id(), reviewed_at = now(), review_note = p_note
  WHERE id = p_submission_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Submission not found or already reviewed.' USING ERRCODE = 'P0001'; END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION review_catalog_brand_submission(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION review_catalog_brand_submission(uuid, boolean, text) TO authenticated;
