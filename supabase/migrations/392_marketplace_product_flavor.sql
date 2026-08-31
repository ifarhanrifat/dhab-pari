-- Migration 392: Most packaged products in a Pakistani corner store come in
-- several flavor/variant editions of the same product+company (a biscuit in
-- plain/chocolate/orange, chips in salted/masala/BBQ, a drink in
-- cola/orange/lemon) — each is its own shop_products row (its own stock and
-- price), so flavor is just another descriptive field alongside company,
-- captured by the AI scan same as company/category, shown next to the
-- product name everywhere so a shopper (or the keeper themself) can tell
-- variants apart in search/catalog/POS.

ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS flavor varchar;
ALTER TABLE shop_products ADD COLUMN IF NOT EXISTS flavor_ur varchar;

-- search_marketplace_products() (389) gains flavor in both the match and
-- the returned shape — same signature, CREATE OR REPLACE is enough.
CREATE OR REPLACE FUNCTION search_marketplace_products(p_query text) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'product_id', p.id, 'product_name', p.name, 'product_name_ur', p.name_ur,
    'flavor', p.flavor, 'flavor_ur', p.flavor_ur, 'unit_price_pkr', p.unit_price_pkr,
    'shop_id', s.id, 'shop_name', s.name, 'shop_name_ur', s.name_ur,
    'shop_location', s.location, 'shop_location_ur', s.location_ur, 'delivery_enabled', s.delivery_enabled
  ) ORDER BY p.unit_price_pkr), '[]'::jsonb)
  FROM shop_products p
  JOIN shops s ON s.id = p.shop_id
  WHERE p.is_active AND s.status = 'active'
    AND (p.name ILIKE '%' || p_query || '%' OR p.name_ur ILIKE '%' || p_query || '%'
      OR p.flavor ILIKE '%' || p_query || '%' OR p.flavor_ur ILIKE '%' || p_query || '%');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
