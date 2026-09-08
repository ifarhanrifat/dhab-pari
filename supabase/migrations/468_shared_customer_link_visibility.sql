-- The other half of household-shared udhar accounts (466): a linked
-- portal user (the husband, say) should be able to see WHICH other
-- portal accounts share the same udhar account with them, by name and
-- mobile number, and remove any of them — themselves or another linked
-- member — the same way any of them could just ask the shopkeeper to.
-- This is deliberately asymmetric with the shopkeeper's own view: the
-- shopkeeper still only ever sees an anonymous count and "User N" labels
-- (list_customer_links, unchanged) — real identity is visible only to
-- people who are THEMSELVES already linked to that same account, i.e.
-- people the household already chose to give access to by handing them
-- a code.

-- Peer view: every OTHER linked portal user's name + mobile, plus the
-- caller's own row flagged via is_me. SECURITY DEFINER because
-- portal_users' own RLS only ever lets someone read their own row —
-- without this, a linked household member could see themselves but
-- nobody else.
CREATE OR REPLACE FUNCTION list_shared_customer_links(p_customer_id uuid)
RETURNS TABLE (link_id uuid, full_name text, mobile text, linked_at timestamptz, is_me boolean) AS $$
DECLARE
  v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shop_customer_links sc WHERE sc.customer_id = p_customer_id AND sc.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You are not linked to this account.';
  END IF;

  RETURN QUERY
  SELECT l.id, pu.full_name::text, pu.mobile::text, l.linked_at, l.portal_user_id = v_portal_user_id
  FROM shop_customer_links l JOIN portal_users pu ON pu.id = l.portal_user_id
  WHERE l.customer_id = p_customer_id
  ORDER BY l.linked_at;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION list_shared_customer_links(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION list_shared_customer_links(uuid) TO authenticated;

-- Peer removal: any currently-linked household member can remove any
-- link on the same account, including their own — the household is
-- trusted to manage this among themselves, the same way any one of them
-- could already ask the shopkeeper to do it. A separate function from
-- the existing self-only unlink_customer_portal(p_customer_id), rather
-- than widening that one's signature — CREATE OR REPLACE with an added
-- parameter creates a whole new overload instead of replacing the old
-- one (the exact bug migration 460 had to clean up for record_shop_sale),
-- and this is a genuinely different operation anyway.
CREATE OR REPLACE FUNCTION unlink_shared_customer_link(p_link_id uuid) RETURNS void AS $$
DECLARE
  v_customer_id uuid;
  v_portal_user_id uuid := current_portal_user_id();
BEGIN
  IF v_portal_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in required.';
  END IF;
  SELECT customer_id INTO v_customer_id FROM shop_customer_links WHERE id = p_link_id;
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Link not found.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM shop_customer_links sc WHERE sc.customer_id = v_customer_id AND sc.portal_user_id = v_portal_user_id) THEN
    RAISE EXCEPTION 'You are not linked to this account.';
  END IF;
  DELETE FROM shop_customer_links WHERE id = p_link_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION unlink_shared_customer_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION unlink_shared_customer_link(uuid) TO authenticated;
