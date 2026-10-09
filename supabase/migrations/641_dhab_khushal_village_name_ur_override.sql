-- Real gap found 2026-10-09: deriveVillageName() (src/lib/publicSite.ts)
-- strips a trailing committee-type suffix from a tenant's English name to
-- get its short village name ("Dhab Khushal Welfare Committee" -> "Dhab
-- Khushal"), but there is no Urdu equivalent -- nameUrdu was passed
-- through untouched. Dhab Khushal's own name_ur, "ویلفئیر کمیٹی ڈھاب
-- خوشحال", stores the committee descriptor as a PREFIX, not a suffix
-- (the opposite word order from the English name), so no single
-- stripping rule could handle both tenants' Urdu names safely without
-- risking mangling a different tenant's real data. With only two other
-- tenants to date (dhab-pari's own name_ur is already short; Dhab
-- Kalan's name_ur is simply unset), a one-off explicit override via the
-- brand_village_name_ur key already built for exactly this case is
-- safer than guessing a general Urdu-parsing rule from a single example.
insert into site_settings (tenant_id, key, value, description)
values (
  '3003eced-193b-44b3-af12-7bcd74512893',
  'brand_village_name_ur',
  'ڈھاب خوشحال',
  'Short Urdu village name override (full name_ur is the complete committee name, prefix-ordered, not suffix-strippable)'
)
on conflict (tenant_id, key) do update set value = excluded.value, description = excluded.description;
