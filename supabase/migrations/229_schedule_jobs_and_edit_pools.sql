-- Migration 229: actually run the two new jobs, and let a pool be edited.
--
-- ═════════════════════════════════════════════════════════════════════════
-- Two gaps found while writing the test plan
-- ═════════════════════════════════════════════════════════════════════════
-- 1. pool_daily_appeal() and sadqa_upkeep_run() were written to be scheduled
--    and then nothing scheduled them. pg_cron is already used in this project
--    (migrations 060, 063, 185, 200, 205), so they join it here. Without this
--    the appeal never re-fires after a committee cover and no upkeep charge is
--    ever raised — both features would look built and do nothing.
--
-- 2. A pool's monthly target is computed from the register, which is right for
--    Kafalat and Wazifa but leaves both pools at zero until there are children
--    or awards on the books. Nothing could set a target by hand, so a brand new
--    committee could not put a pool in front of anybody. Editing is exposed
--    below and covers the ordinary case too: adjusting the suggested share as
--    the pool grows, which is the one number that is meant to move.

-- Runs daily at 09:00 Pakistan time (04:00 UTC). Both are idempotent, so a
-- missed day or a double run changes nothing.
DO $$
BEGIN
  PERFORM cron.schedule('pool-daily-appeal', '0 4 * * *', 'SELECT pool_daily_appeal()');
  RAISE NOTICE 'pg_cron: pool appeals checked daily at 09:00 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run pool_daily_appeal() from the Pools screen. %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM cron.schedule('sadqa-upkeep-run', '5 4 * * *', 'SELECT sadqa_upkeep_run()');
  RAISE NOTICE 'pg_cron: sadqa upkeep checked daily at 09:05 PKT';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron unavailable — run sadqa_upkeep_run() from the Esal-e-Sawab screen. %', SQLERRM;
END $$;

-- ── Editing a pool ───────────────────────────────────────────────────────
-- The suggested share is the number that is supposed to move: as the pool
-- grows, the next person is asked for less. Everything a donor already agreed
-- to is untouched by this — that promise is the whole basis of the design, so
-- this function cannot reach pool_commitments at all.
CREATE OR REPLACE FUNCTION pool_update(
  p_pool_id uuid,
  p_name varchar DEFAULT NULL,
  p_name_ur varchar DEFAULT NULL,
  p_suggested_share decimal DEFAULT NULL,
  p_min_share decimal DEFAULT NULL,
  p_reserve_months decimal DEFAULT NULL,
  p_manual_monthly_target decimal DEFAULT NULL,
  -- Passed true to go back to computing the target from the register.
  p_clear_manual_target boolean DEFAULT false,
  p_is_active boolean DEFAULT NULL,
  p_description text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE p support_pools%ROWTYPE;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO p FROM support_pools WHERE id = p_pool_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pool not found' USING ERRCODE = 'P0001'; END IF;

  IF p_suggested_share IS NOT NULL AND p_suggested_share <= 0 THEN
    RAISE EXCEPTION 'The suggested share has to be more than zero.' USING ERRCODE = 'P0001';
  END IF;
  IF p_manual_monthly_target IS NOT NULL AND p_manual_monthly_target < 0 THEN
    RAISE EXCEPTION 'A monthly target cannot be negative.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE support_pools SET
    name = COALESCE(p_name, name),
    name_ur = COALESCE(p_name_ur, name_ur),
    suggested_share_pkr = COALESCE(p_suggested_share, suggested_share_pkr),
    min_share_pkr = COALESCE(p_min_share, min_share_pkr),
    reserve_months = COALESCE(p_reserve_months, reserve_months),
    manual_monthly_target_pkr = CASE WHEN p_clear_manual_target THEN NULL
                                     ELSE COALESCE(p_manual_monthly_target, manual_monthly_target_pkr) END,
    is_active = COALESCE(p_is_active, is_active),
    description = COALESCE(p_description, description),
    updated_at = now()
  WHERE id = p_pool_id;

  RETURN pool_position(p_pool_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_update(uuid, varchar, varchar, decimal, decimal, decimal, decimal, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_update(uuid, varchar, varchar, decimal, decimal, decimal, decimal, boolean, boolean, text) TO authenticated;

-- Creating one by hand, for a cost that is not a child, a student or a sadqa
-- object — the mosque's electricity, the graveyard wall, the ambulance diesel.
CREATE OR REPLACE FUNCTION pool_create(
  p_name varchar, p_monthly_target decimal, p_suggested_share decimal DEFAULT 1000,
  p_name_ur varchar DEFAULT NULL, p_description text DEFAULT NULL,
  p_fund_type varchar DEFAULT 'sadqa'
) RETURNS jsonb AS $$
DECLARE v_id uuid; v_code varchar;
BEGIN
  IF current_admin_role() NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'Give the pool a name people will recognise.' USING ERRCODE = 'P0001';
  END IF;
  IF p_monthly_target <= 0 THEN
    RAISE EXCEPTION 'What does this cost every month?' USING ERRCODE = 'P0001';
  END IF;

  v_code := 'POOL-' || upper(substr(regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g'), 1, 8))
            || '-' || to_char(now(), 'MMDD');

  INSERT INTO support_pools (code, name, name_ur, kind, fund_type,
                             manual_monthly_target_pkr, suggested_share_pkr, min_share_pkr,
                             description)
  VALUES (v_code, p_name, p_name_ur, 'general', p_fund_type, p_monthly_target,
          LEAST(GREATEST(p_suggested_share, 100), p_monthly_target),
          LEAST(100, p_monthly_target), p_description)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('pool_id', v_id, 'code', v_code, 'position', pool_position(v_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION pool_create(varchar, decimal, decimal, varchar, text, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION pool_create(varchar, decimal, decimal, varchar, text, varchar) TO authenticated;
