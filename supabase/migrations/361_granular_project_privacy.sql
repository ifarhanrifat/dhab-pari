-- Migration 361: the "fully private" flag (migration 359) was more than
-- what was actually asked for — the real request was "hide the donor
-- names, nothing else" for medical projects; everything else (the project
-- listing, its description, its totals) should stay visible. Replacing
-- the single is_private switch with independent, combinable controls:
-- hide the donation list, hide the expense list, hide donor names only
-- (amounts still shown) — is_private itself stays as the "everything"
-- option for a project that genuinely needs full invisibility, not
-- removed, just no longer the only choice.
--
-- Also closes a real gap found while wiring this: donors_public,
-- project_expenses_public and project_accounts_public (migrations
-- 116/133/182) are plain views granted straight to anon, with zero idea
-- is_private/these new flags exist — a private project's donor/expense
-- list could still leak to anyone who knew or guessed its id directly,
-- even though the project row itself was correctly blocked by RLS.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS hide_donations boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hide_expenses boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hide_donor_names boolean NOT NULL DEFAULT false;

-- donors_public: donor rows for a project with hide_donations (or fully
-- private) are omitted entirely; hide_donor_names keeps the row (amount,
-- date) but blanks the name, same treatment an anonymous donor already
-- gets. General-fund donations (project_id IS NULL) are never touched by
-- any of this — the LEFT JOIN + this WHERE keeps them unaffected.
CREATE OR REPLACE VIEW donors_public AS
SELECT d.id,
       CASE
         WHEN d.is_anonymous THEN 'Anonymous'
         WHEN p.hide_donor_names THEN 'Confidential'
         ELSE d.name
       END AS name,
       CASE WHEN d.is_anonymous OR p.hide_donor_names THEN NULL ELSE d.name_ur END AS name_ur,
       d.amount_pkr, d.date, d.project_id, d.donor_type, d.is_verified, d.payment_status
FROM donors d
LEFT JOIN projects p ON p.id = d.project_id
WHERE d.project_id IS NULL
   OR (COALESCE(p.is_private, false) = false AND COALESCE(p.hide_donations, false) = false);

GRANT SELECT ON donors_public TO anon, authenticated;

-- project_expenses_public: omitted entirely for a project with
-- hide_expenses (or fully private). No name-blanking equivalent here —
-- "hide donor names" is specifically about the people giving money, not
-- expense category labels ("Doctor Fee", "Vehicle Rent"), which aren't
-- personally identifying.
CREATE OR REPLACE VIEW project_expenses_public AS
SELECT a.project_id, le.id, le.entry_date, le.particular, le.debit
FROM ledger_entries le
JOIN accounts a ON a.id = le.account_id
JOIN projects p ON p.id = a.project_id
WHERE a.project_id IS NOT NULL AND le.debit > 0
  AND p.is_private = false AND p.hide_expenses = false;

GRANT SELECT ON project_expenses_public TO anon, authenticated;

-- project_accounts_public: only gated by is_private (full lockdown) — a
-- project with just hide_donations/hide_expenses/hide_donor_names still
-- needs its account to be discoverable so the detail page's expense
-- query (itself correctly filtered above) has something to query against.
CREATE OR REPLACE VIEW project_accounts_public AS
SELECT a.id, a.project_id FROM accounts a
JOIN projects p ON p.id = a.project_id
WHERE a.project_id IS NOT NULL AND p.is_private = false;

GRANT SELECT ON project_accounts_public TO anon, authenticated;
