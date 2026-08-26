-- Migration 364: privacy flags (361) hide the donation list, the donor
-- names, or the whole card — none of them help when the leak is the
-- project's own title, e.g. a medical account literally named after the
-- patient ("محمد ارشد دلیال میڈیکل اخراجات"). Renaming that title outright
-- would work publicly but breaks the accountant's own ability to find the
-- right account, and legal/ledger references should stay exact.
--
-- display_name is a second, optional label: when set, every donor-facing
-- surface (project card, detail page, donate-page project picker, the
-- donation-thanks ticker, and receipts/WhatsApp messages handed to a
-- donor) shows it instead of the real title. Every admin/accounting
-- screen keeps reading `title` untouched — this is a display swap at the
-- public-facing edges, not a rename, so the ledger/account/project
-- identity never changes.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS display_name text;

-- The ticker (205, guarded by 360/362) is generated server-side, so it
-- needs the same preference applied here rather than in the client.
CREATE OR REPLACE FUNCTION donation_thanks_text(p_donor_id uuid, p_lang text)
RETURNS text AS $$
DECLARE
  d donors%ROWTYPE; v_project text; v_tpl text;
BEGIN
  SELECT * INTO d FROM donors WHERE id = p_donor_id;
  IF d.id IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(nullif(trim(display_name), ''),
           CASE WHEN p_lang = 'ur' THEN COALESCE(nullif(trim(title_ur), ''), title) ELSE title END)
    INTO v_project FROM projects WHERE id = d.project_id;
  v_project := COALESCE(v_project,
    CASE WHEN p_lang = 'ur' THEN 'جنرل فنڈ' ELSE 'the General Fund' END);

  v_tpl := CASE WHEN p_lang = 'ur'
    THEN setting_text('donation_thanks_ur', '%%who%% نے %%project%% کے لیے %%amount%% روپے کا عطیہ دیا ہے۔ جزاک اللہ خیر')
    ELSE setting_text('donation_thanks_en', '%%who%% has donated Rs. %%amount%% for %%project%%. Jazak Allah Khair') END;

  v_tpl := replace(v_tpl, '%%who%%', COALESCE(donation_thanks_who(p_donor_id, p_lang), ''));
  v_tpl := replace(v_tpl, '%%project%%', v_project);
  v_tpl := replace(v_tpl, '%%amount%%', trim(to_char(d.amount_pkr, 'FM999,999,999,990')));
  RETURN v_tpl;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
