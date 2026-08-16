-- Migration 255: a payment_batch_id can span both tables — a donor covering
-- a Kafalat share, a Wazifa share and a general project pledge in one bank
-- transfer touches pool_payments AND donors at once. Each admin queue
-- (donors/kafalat/wazifa/esal-e-sawab) only ever sees its own table, so a
-- badge built from local data alone would understate the total whenever a
-- batch crosses queues. This aggregates across both, so every page shows
-- the same true count/total for a given batch regardless of where it's
-- looking from.
CREATE OR REPLACE FUNCTION payment_batch_summary(p_batch_ids uuid[]) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_object_agg(batch_id, jsonb_build_object('count', cnt, 'total', total)), '{}'::jsonb)
  FROM (
    SELECT payment_batch_id AS batch_id, count(*) AS cnt, sum(amount_pkr) AS total
      FROM (
        SELECT payment_batch_id, amount_pkr FROM donors
         WHERE payment_batch_id = ANY(p_batch_ids) AND NOT is_verified
        UNION ALL
        SELECT payment_batch_id, amount_pkr FROM pool_payments
         WHERE payment_batch_id = ANY(p_batch_ids) AND status = 'announced'
      ) x
     GROUP BY payment_batch_id
  ) grouped;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION payment_batch_summary(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION payment_batch_summary(uuid[]) TO authenticated;
