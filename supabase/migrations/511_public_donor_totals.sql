-- Real ask, 2026-09-25: the public /donate honor wall lists individual
-- donations, not donors — a repeat donor shows up as several separate
-- rows instead of being ranked by lifetime total. This groups them by the
-- same donor identity ensure_donor_account()/donor_receipt_totals() already
-- use elsewhere (ledger-derived accounts.donor_key, falling back to
-- donor_key_for(name, phone) for a donation that never posted through the
-- ledger) — never a fresh name-text match, which would wrongly merge two
-- different people who share a name.
--
-- Anonymous donations, and donations to a project with hide_donor_names,
-- are deliberately left OUT of the grouping: merging them into a real
-- identity's public total would let that total implicitly reveal how much
-- someone gave under an identity-hiding setting, defeating the point of
-- that setting (granular_project_privacy, migration 361). They still
-- appear as their own ungrouped "Anonymous"/"Confidential" rows, same as
-- donors_public already shows today — just never merged with each other
-- or with a named identity.
--
-- Public/anon-callable like donors_public itself (no can_access_system()
-- gate) — this only ever aggregates fields donors_public already exposes.
CREATE OR REPLACE FUNCTION donors_public_totals()
RETURNS TABLE (name varchar, name_ur varchar, total_pkr numeric, donation_count int, last_date date, project_id uuid) AS $$
BEGIN
  RETURN QUERY
  SELECT g.name, g.name_ur, g.total_pkr, g.donation_count, g.last_date, NULL::uuid AS project_id
  FROM (
    SELECT
      (array_agg(d.name ORDER BY d.date DESC))[1]::varchar AS name,
      (array_agg(d.name_ur ORDER BY d.date DESC))[1]::varchar AS name_ur,
      SUM(d.amount_pkr) AS total_pkr,
      COUNT(*)::int AS donation_count,
      MAX(d.date) AS last_date
    FROM donors d
    LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.is_verified = true AND d.is_anonymous = false
      AND (d.project_id IS NULL OR (
        COALESCE(p.is_private, false) = false
        AND COALESCE(p.hide_donations, false) = false
        AND COALESCE(p.hide_donor_names, false) = false
      ))
    GROUP BY COALESCE(
      (SELECT a.donor_key FROM ledger_entries le JOIN accounts a ON a.id = le.account_id
       WHERE le.reference_type = 'donation' AND le.reference_id = d.id AND a.type = 'donor' LIMIT 1),
      donor_key_for(d.name, d.phone)
    )
  ) g

  UNION ALL

  SELECT
    (CASE WHEN d.is_anonymous THEN 'Anonymous' ELSE 'Confidential' END)::varchar AS name,
    NULL::varchar AS name_ur,
    d.amount_pkr AS total_pkr,
    1 AS donation_count,
    d.date AS last_date,
    d.project_id
  FROM donors d
  LEFT JOIN projects p ON p.id = d.project_id
  WHERE d.is_verified = true
    AND (d.project_id IS NULL OR (COALESCE(p.is_private, false) = false AND COALESCE(p.hide_donations, false) = false))
    AND (d.is_anonymous OR COALESCE(p.hide_donor_names, false));
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION donors_public_totals() TO anon, authenticated;
