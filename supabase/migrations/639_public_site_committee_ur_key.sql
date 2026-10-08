-- One more key missed in 638: HomeHero's Urdu hero heading shows the
-- committee-type descriptor ("Water & Welfare Committee") on its own
-- line, separately from the village name below it -- a dhab-pari-only
-- stylistic split with no other field to derive it from. New tenants
-- have no committee-type descriptor set (empty), so HomeHero renders
-- just its own name heading instead of a blank/duplicate line.
insert into site_settings (tenant_id, key, value, description) values
  ('bf9e4815-4104-472a-ab32-114171b7e34d', 'brand_committee_ur', 'واٹر اینڈ ویلفیئر کمیٹی', 'Public site: committee-type descriptor shown above the village name on the homepage hero (Urdu). Blank hides that line.')
on conflict (tenant_id, key) do nothing;
