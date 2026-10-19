-- Migration 708: "there will be dropdown and search list for the cars
-- that will contain all the models avaialbe in pakistan and there user
-- can add new model if the dropdown will not have the model which his
-- vehical is" — confirmed fully greenfield, no make/model reference
-- table existed anywhere before this.

CREATE TABLE IF NOT EXISTS vehicle_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT COALESCE(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid) REFERENCES tenants(id),
  category_id uuid REFERENCES vehicle_categories(id),
  make varchar NOT NULL,
  model varchar NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, make, model)
);
ALTER TABLE vehicle_models ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vehicle_models_read" ON vehicle_models FOR SELECT TO authenticated USING (tenant_id = my_tenant_id());
-- Writes only via add_vehicle_model() below.

CREATE OR REPLACE FUNCTION vehicle_models_search(p_query text DEFAULT NULL, p_category_id uuid DEFAULT NULL)
RETURNS TABLE(id uuid, make varchar, model varchar, category_id uuid) AS $$
  SELECT m.id, m.make, m.model, m.category_id
  FROM vehicle_models m
  WHERE m.tenant_id = my_tenant_id() AND m.is_active
    AND (p_category_id IS NULL OR m.category_id = p_category_id)
    AND (p_query IS NULL OR trim(p_query) = '' OR (m.make || ' ' || m.model) ILIKE '%' || trim(p_query) || '%')
  ORDER BY m.make, m.model
  LIMIT 50;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION vehicle_models_search(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION vehicle_models_search(text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION add_vehicle_model(p_make varchar, p_model varchar, p_category_id uuid DEFAULT NULL) RETURNS uuid AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); v_id uuid;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  IF trim(coalesce(p_make, '')) = '' OR trim(coalesce(p_model, '')) = '' THEN
    RAISE EXCEPTION 'Enter both the make and model.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO vehicle_models (tenant_id, category_id, make, model, created_by_portal_user_id)
  VALUES (my_tenant_id(), p_category_id, trim(p_make), trim(p_model), v_portal_user_id)
  ON CONFLICT (tenant_id, make, model) DO UPDATE SET is_active = true
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION add_vehicle_model(varchar, varchar, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_vehicle_model(varchar, varchar, uuid) TO authenticated;

-- Seed: common Pakistani makes/models spread across every category,
-- linked to this tenant's own vehicle_categories rows.
INSERT INTO vehicle_models (tenant_id, category_id, make, model)
SELECT t.id, vc.id, s.make, s.model
FROM tenants t
CROSS JOIN (VALUES
  ('car', 'Suzuki', 'Mehran'), ('car', 'Suzuki', 'Alto'), ('car', 'Suzuki', 'Cultus'), ('car', 'Suzuki', 'Wagon R'), ('car', 'Suzuki', 'Swift'),
  ('car', 'Toyota', 'Corolla'), ('car', 'Toyota', 'Vitz'), ('car', 'Toyota', 'Aqua'), ('car', 'Toyota', 'Prius'),
  ('car', 'Honda', 'City'), ('car', 'Honda', 'Civic'), ('car', 'Honda', 'BR-V'),
  ('car', 'Daihatsu', 'Mira'), ('car', 'Daihatsu', 'Coure'), ('car', 'KIA', 'Sportage'), ('car', 'Hyundai', 'Tucson'),
  ('bike', 'Honda', 'CD-70'), ('bike', 'Honda', 'CG-125'), ('bike', 'Honda', 'CB-150F'),
  ('bike', 'Yamaha', 'YBR-125'), ('bike', 'Suzuki', 'GS-150'), ('bike', 'United', 'US-70'),
  ('bike', 'Road Prince', 'RP-70'), ('bike', 'Unique', 'UD-70'),
  ('rickshaw', 'Sazgar', 'Rickshaw'), ('rickshaw', 'New Asia', 'Rickshaw'), ('rickshaw', 'Qingqi', 'Rickshaw'),
  ('van', 'Suzuki', 'Bolan'), ('van', 'Suzuki', 'Ravi'), ('van', 'Toyota', 'Hiace'), ('van', 'Daihatsu', 'Hijet'),
  ('loader', 'Mazda', 'Loader'), ('loader', 'Toyota', 'Dyna'), ('loader', 'Suzuki', 'Carry'),
  ('tractor', 'Massey Ferguson', 'MF-260'), ('tractor', 'Massey Ferguson', 'MF-385'), ('tractor', 'New Holland', 'Ghazi'), ('tractor', 'Fiat', '480'),
  ('machinery', 'JCB', '3DX Backhoe Loader'), ('machinery', 'Caterpillar', 'Excavator'), ('machinery', 'Sonalika', 'Crane')
) AS s(cat_key, make, model)
JOIN vehicle_categories vc ON vc.key = s.cat_key AND vc.tenant_id = t.id
ON CONFLICT (tenant_id, make, model) DO NOTHING;
