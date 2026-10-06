-- Phase 2, slice 1 (functions): the two SECURITY DEFINER functions that
-- touch this slice's tables and needed fixing, same two bug classes as
-- phase 1's migration 569.

create or replace function public.next_complaint_number(p_system character varying)
 returns character varying
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_serial int;
  v_prefix varchar := CASE WHEN p_system = 'water_supply' THEN 'WS-CMP' ELSE 'DP-CMP' END;
  v_tenant uuid := coalesce(my_tenant_id(), 'bf9e4815-4104-472a-ab32-114171b7e34d'::uuid);
BEGIN
  UPDATE complaint_number_counters SET next_serial = next_serial + 1
  WHERE tenant_id = v_tenant AND system = p_system
  RETURNING next_serial - 1 INTO v_serial;
  RETURN v_prefix || '-' || lpad(v_serial::text, 4, '0');
END;
$function$;

-- run_nonpayment_flag_sweep is a pg_cron job (0 8 * * *, no authenticated
-- user at all) that joins bills/consumers (already tenant-scoped since
-- phase 1) with no tenant filter — it would mix every tenant's consumers
-- into one combined computation, and every flag it inserts would default
-- to Dhab Pari's tenant regardless of whose consumer it actually is (the
-- same no-auth-context DEFAULT problem as run_recurring_schedule in
-- migration 569). Fixed by carrying tenant_id through every CTE from
-- consumers' own tenant_id, and setting it explicitly on insert.
create or replace function public.run_nonpayment_flag_sweep()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  v_popup_enabled boolean;
  r record;
  h record;
BEGIN
  DROP TABLE IF EXISTS _np_current;
  CREATE TEMP TABLE _np_current AS
  WITH bill_calc AS (
    SELECT
      b.consumer_id,
      c.tenant_id,
      GREATEST(b.amount_pkr - COALESCE(b.discount_amount, 0) - COALESCE(b.paid_amount, 0), 0) AS outstanding,
      ROW_NUMBER() OVER (PARTITION BY b.consumer_id ORDER BY b.year DESC, b.month DESC) AS rn,
      (b.year * 12 + b.month) AS ym
    FROM bills b
    JOIN consumers c ON c.consumer_id = b.consumer_id
    WHERE c.status = 'active'
  ),
  latest_two AS (
    SELECT consumer_id,
      COUNT(*) AS cnt,
      MAX(ym) FILTER (WHERE rn = 1) AS ym1,
      MAX(ym) FILTER (WHERE rn = 2) AS ym2,
      BOOL_AND(outstanding > 0) FILTER (WHERE rn <= 2) AS both_unpaid
    FROM bill_calc
    WHERE rn <= 2
    GROUP BY consumer_id
  ),
  flagged AS (
    SELECT lt.consumer_id
    FROM latest_two lt
    WHERE lt.cnt = 2 AND lt.both_unpaid AND (lt.ym1 - lt.ym2) = 1
  )
  SELECT bc.consumer_id, c.sector, c.tenant_id, SUM(bc.outstanding) AS total_outstanding
  FROM bill_calc bc
  JOIN consumers c ON c.consumer_id = bc.consumer_id
  WHERE bc.outstanding > 0 AND bc.consumer_id IN (SELECT consumer_id FROM flagged)
  GROUP BY bc.consumer_id, c.sector, c.tenant_id;

  SELECT popup_enabled INTO v_popup_enabled FROM notification_preferences WHERE event_type = 'consumer_flagged_nonpayment';

  FOR r IN SELECT * FROM _np_current WHERE consumer_id NOT IN (SELECT consumer_id FROM consumer_nonpayment_flags) LOOP
    INSERT INTO consumer_nonpayment_flags (consumer_id, sector, total_outstanding, tenant_id)
    VALUES (r.consumer_id, r.sector, r.total_outstanding, r.tenant_id);

    IF v_popup_enabled IS DISTINCT FROM false AND r.sector IS NOT NULL THEN
      FOR h IN
        SELECT id FROM admin_users
        WHERE is_active = true AND can_collect_payments = true AND r.sector = ANY(assigned_sectors) AND tenant_id = r.tenant_id
      LOOP
        INSERT INTO notifications (recipient_id, event_type, title, body, link)
        VALUES (h.id, 'consumer_flagged_nonpayment', 'Non-payment: ' || r.consumer_id,
          'Rs. ' || to_char(r.total_outstanding, 'FM999999990.00') || ' outstanding in ' || r.sector, '/admin/reports/non-payment');
      END LOOP;
    END IF;
  END LOOP;

  UPDATE consumer_nonpayment_flags f
  SET total_outstanding = c.total_outstanding, last_checked_at = now()
  FROM _np_current c
  WHERE f.consumer_id = c.consumer_id;

  DELETE FROM consumer_nonpayment_flags
  WHERE consumer_id NOT IN (SELECT consumer_id FROM _np_current);

  DROP TABLE _np_current;
END;
$function$;
