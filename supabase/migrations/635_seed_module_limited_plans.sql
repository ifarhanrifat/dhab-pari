-- Real gap: only one plan ("Starter", both modules) existed, so the
-- includes_water_supply/includes_donors_projects mechanism built in
-- migration 628 had nothing to actually demonstrate -- no tenant could
-- ever pick a water-only or donors-only plan because none existed. The
-- Plans admin console (now with an Edit action, see the same session's
-- UI change) already lets the platform operator set real prices for
-- these — the numbers below are a starting point to edit, not a
-- pricing decision made on the operator's behalf.
insert into subscription_plans (key, name, monthly_price_pkr, commission_pct, max_admin_users, includes_water_supply, includes_donors_projects)
values
  ('water_only', 'Water Supply Only', 4000, 0, 2, true, false),
  ('donors_only', 'Donors & Projects Only', 7000, 5, 3, false, true)
on conflict (key) do nothing;
