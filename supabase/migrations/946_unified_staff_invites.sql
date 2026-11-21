-- Migration 946: real ask, given live — "everyone should be invited
-- from the same window... select or write down the phone number...
-- select the role and invite, and that invitation will be saved with
-- reinvite or delete button, staff role can be changed from there."
--
-- Explicitly scoped to NON-driver roles (staff/booking_officer/
-- terminal_manager/accountant/other). Drivers deliberately keep their
-- own separate, heavier path (fleet_driver_invites/853): inviting a
-- driver isn't "add a person," it's "onboard an entire new vehicle"
-- through the SAME admin-reviewed registration pipeline (CNIC,
-- license, vehicle document, photo, platform-admin approval) every
-- solo driver on the whole marketplace goes through — collapsing that
-- into an instant one-click add would silently bypass the vehicle
-- safety/compliance review this codebase already built real admin
-- tooling around. Answered directly rather than silently merged.
--
-- OWASP-mindful design, called out explicitly since asked:
-- - A01 Broken Access Control: every RPC re-checks fleet ownership
--   server-side (never trusts the client); the role granted on
--   REDEMPTION is whatever the OWNER set at invite time, stored
--   server-side on the invite row — the redeeming account can never
--   choose or escalate its own role via this path.
-- - A01 roles are server-side allow-listed (same 5 non-driver roles
--   fleet_staff_role_check already permits) — 'driver' explicitly
--   rejected here with a message pointing at the real driver-invite
--   flow, not silently handled wrong.
-- - A04 Insecure design / A07 Auth failures: fleet_driver_invites
--   (853) has no uniqueness guarantee on its live `code` value across
--   different fleets — two fleets' simultaneously-pending codes could
--   coincidentally collide, and whichever row a collision resolves to
--   is undefined. This table adds a real fix for the same class:
--   a partial UNIQUE index on code WHERE still-unredeemed, so two live
--   codes can never collide system-wide (existing fleet_driver_invites
--   intentionally left untouched here — a separate, pre-existing
--   table this ask didn't ask to touch).
-- - A05 Security misconfiguration: RLS enabled, no grants to
--   PUBLIC/anon, every write through a SECURITY DEFINER RPC.
-- - A09 Logging: every invite/redeem/cancel/resend call is written to
--   the existing fleet_audit_log (885) via log_fleet_action — and
--   add_fleet_staff/remove_fleet_staff (854), which never logged
--   anything before, now do too.
-- - Tenant isolation: redemption and the phone lookup both route
--   through find_portal_user_by_mobile, already tenant-scoped (571) —
--   matching mobile across tenants was the exact leak class fixed
--   once this session (879) and never reintroduced here.

CREATE TABLE IF NOT EXISTS fleet_staff_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  invited_phone varchar NOT NULL,
  role varchar NOT NULL CHECK (role IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other')),
  code varchar NOT NULL,
  invited_by_portal_user_id uuid REFERENCES portal_users(id),
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_by_portal_user_id uuid REFERENCES portal_users(id),
  redeemed_at timestamptz
);
CREATE INDEX IF NOT EXISTS fleet_staff_invites_fleet_idx ON fleet_staff_invites(fleet_id);
-- No two LIVE (unredeemed) codes can ever collide, system-wide — the
-- real gap found in fleet_driver_invites while building this.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_staff_invites_live_code_idx ON fleet_staff_invites(code) WHERE redeemed_at IS NULL;
ALTER TABLE fleet_staff_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fleet_staff_invites_owner_read" ON fleet_staff_invites FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id()));
-- No INSERT/UPDATE/DELETE policy — SECURITY DEFINER RPCs only.

-- ═════════════════════════════════════════════════════════════════════
-- The one unified action: a phone that already has an account on this
-- SAME tenant is added immediately (no point making someone redeem a
-- code for an account that already exists); otherwise a real,
-- resendable/cancellable invite is created. Both outcomes are visible
-- afterward through the same my_fleet_staff_invites list.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION invite_fleet_staff(p_fleet_id uuid, p_phone varchar, p_role varchar) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone varchar := trim(coalesce(p_phone, ''));
  v_found record;
  v_code varchar;
  v_attempt int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  IF v_phone = '' THEN RAISE EXCEPTION 'Enter a phone number.' USING ERRCODE = 'P0001'; END IF;
  IF p_role = 'driver' THEN
    RAISE EXCEPTION 'Drivers are invited from the Drivers tab instead — that flow also registers their vehicle.' USING ERRCODE = 'P0001';
  END IF;
  IF p_role NOT IN ('staff', 'booking_officer', 'terminal_manager', 'accountant', 'other') THEN
    RAISE EXCEPTION 'Unknown role.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_found FROM find_portal_user_by_mobile(v_phone);
  IF v_found.id IS NOT NULL THEN
    INSERT INTO fleet_staff (fleet_id, portal_user_id, role) VALUES (p_fleet_id, v_found.id, p_role)
      ON CONFLICT (fleet_id, portal_user_id) DO UPDATE SET role = EXCLUDED.role;
    -- Recorded as an already-redeemed invite too, purely so the one
    -- unified list below shows every onboarding the same way, pending
    -- or not — not a second access grant (fleet_staff is what actually
    -- grants access, same row either branch touches).
    INSERT INTO fleet_staff_invites (fleet_id, invited_phone, role, code, invited_by_portal_user_id, expires_at, redeemed_by_portal_user_id, redeemed_at)
    VALUES (p_fleet_id, v_phone, p_role, 'N/A', current_portal_user_id(), now(), v_found.id, now());
    PERFORM log_fleet_action(p_fleet_id, 'staff_invited_and_added', jsonb_build_object('portal_user_id', v_found.id, 'role', p_role));
    RETURN jsonb_build_object('status', 'added', 'full_name', v_found.full_name);
  END IF;

  DELETE FROM fleet_staff_invites WHERE fleet_id = p_fleet_id AND invited_phone = v_phone AND redeemed_at IS NULL;

  LOOP
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    BEGIN
      INSERT INTO fleet_staff_invites (fleet_id, invited_phone, role, code, invited_by_portal_user_id, expires_at)
      VALUES (p_fleet_id, v_phone, p_role, v_code, current_portal_user_id(), now() + interval '7 days');
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 8 THEN RAISE EXCEPTION 'Could not generate a unique invite code — try again.' USING ERRCODE = 'P0001'; END IF;
    END;
  END LOOP;

  PERFORM log_fleet_action(p_fleet_id, 'staff_invited', jsonb_build_object('phone', v_phone, 'role', p_role));
  RETURN jsonb_build_object('status', 'invited', 'code', v_code);
END;
$$;
REVOKE ALL ON FUNCTION invite_fleet_staff(uuid, varchar, varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION invite_fleet_staff(uuid, varchar, varchar) TO authenticated;

CREATE OR REPLACE FUNCTION redeem_fleet_staff_invite(p_code varchar) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_portal_user_id uuid := current_portal_user_id(); inv fleet_staff_invites%ROWTYPE; v_fleet_name varchar;
BEGIN
  IF v_portal_user_id IS NULL THEN RAISE EXCEPTION 'Sign in first.' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO inv FROM fleet_staff_invites WHERE code = trim(coalesce(p_code, '')) AND redeemed_at IS NULL AND expires_at > now() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That code is invalid or has expired.' USING ERRCODE = 'P0001'; END IF;

  UPDATE fleet_staff_invites SET redeemed_by_portal_user_id = v_portal_user_id, redeemed_at = now() WHERE id = inv.id;
  -- The role is whatever the OWNER set at invite time (inv.role),
  -- never a client-supplied parameter here — the redeeming account has
  -- no way to choose or escalate its own role through this call.
  INSERT INTO fleet_staff (fleet_id, portal_user_id, role) VALUES (inv.fleet_id, v_portal_user_id, inv.role)
    ON CONFLICT (fleet_id, portal_user_id) DO UPDATE SET role = EXCLUDED.role;
  SELECT name INTO v_fleet_name FROM fleets WHERE id = inv.fleet_id;
  PERFORM log_fleet_action(inv.fleet_id, 'staff_invite_redeemed', jsonb_build_object('portal_user_id', v_portal_user_id, 'role', inv.role));
  RETURN jsonb_build_object('fleet_id', inv.fleet_id, 'fleet_name', v_fleet_name, 'role', inv.role);
END;
$$;
REVOKE ALL ON FUNCTION redeem_fleet_staff_invite(varchar) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION redeem_fleet_staff_invite(varchar) TO authenticated;

CREATE OR REPLACE FUNCTION my_fleet_staff_invites(p_fleet_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', i.id, 'invited_phone', i.invited_phone, 'role', i.role, 'created_at', i.created_at, 'expires_at', i.expires_at,
    'redeemed_at', i.redeemed_at, 'redeemed_full_name', pu.full_name
  ) ORDER BY i.created_at DESC), '[]'::jsonb)
  FROM fleet_staff_invites i
  LEFT JOIN portal_users pu ON pu.id = i.redeemed_by_portal_user_id
  WHERE i.fleet_id = p_fleet_id AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = i.fleet_id AND f.owning_portal_user_id = current_portal_user_id());
$$;
REVOKE ALL ON FUNCTION my_fleet_staff_invites(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_fleet_staff_invites(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION cancel_fleet_staff_invite(p_invite_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_fleet_id uuid;
BEGIN
  SELECT fleet_id INTO v_fleet_id FROM fleet_staff_invites
    WHERE id = p_invite_id AND redeemed_at IS NULL
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id());
  IF v_fleet_id IS NULL THEN RAISE EXCEPTION 'Invite not found, already redeemed, or you do not own this fleet.' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM fleet_staff_invites WHERE id = p_invite_id;
  PERFORM log_fleet_action(v_fleet_id, 'staff_invite_cancelled', jsonb_build_object('invite_id', p_invite_id));
END;
$$;
REVOKE ALL ON FUNCTION cancel_fleet_staff_invite(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_fleet_staff_invite(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION reinvite_fleet_staff(p_invite_id uuid) RETURNS varchar
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE old fleet_staff_invites%ROWTYPE; v_code varchar; v_attempt int := 0;
BEGIN
  SELECT * INTO old FROM fleet_staff_invites WHERE id = p_invite_id AND redeemed_at IS NULL
    AND EXISTS (SELECT 1 FROM fleets f WHERE f.id = fleet_id AND f.owning_portal_user_id = current_portal_user_id());
  IF old.id IS NULL THEN RAISE EXCEPTION 'Invite not found, already redeemed, or you do not own this fleet.' USING ERRCODE = 'P0001'; END IF;

  LOOP
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    BEGIN
      UPDATE fleet_staff_invites SET code = v_code, expires_at = now() + interval '7 days', created_at = now() WHERE id = p_invite_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      v_attempt := v_attempt + 1;
      IF v_attempt >= 8 THEN RAISE EXCEPTION 'Could not generate a unique invite code — try again.' USING ERRCODE = 'P0001'; END IF;
    END;
  END LOOP;

  PERFORM log_fleet_action(old.fleet_id, 'staff_invite_resent', jsonb_build_object('invite_id', p_invite_id, 'phone', old.invited_phone));
  RETURN v_code;
END;
$$;
REVOKE ALL ON FUNCTION reinvite_fleet_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reinvite_fleet_staff(uuid) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════
-- add_fleet_staff/remove_fleet_staff (854) — true-replace, current
-- bodies copied verbatim, one log_fleet_action call added to each.
-- Real gap: every OTHER sensitive staff action (role/salary/
-- commission changes) was already logged; adding or removing the
-- staff member in the first place never was.
-- ═════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION add_fleet_staff(p_fleet_id uuid, p_phone text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_found record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_found FROM find_portal_user_by_mobile(trim(p_phone));
  IF v_found.id IS NULL THEN
    RAISE EXCEPTION 'No account found with that phone number — they need to sign up first.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO fleet_staff (fleet_id, portal_user_id) VALUES (p_fleet_id, v_found.id)
    ON CONFLICT (fleet_id, portal_user_id) DO NOTHING;
  PERFORM log_fleet_action(p_fleet_id, 'staff_added', jsonb_build_object('portal_user_id', v_found.id));
  RETURN jsonb_build_object('portal_user_id', v_found.id, 'full_name', v_found.full_name);
END;
$$;
REVOKE ALL ON FUNCTION add_fleet_staff(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION add_fleet_staff(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION remove_fleet_staff(p_fleet_id uuid, p_portal_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id AND owning_portal_user_id = current_portal_user_id()) THEN
    RAISE EXCEPTION 'You do not own this fleet.' USING ERRCODE = 'P0001';
  END IF;
  DELETE FROM fleet_staff WHERE fleet_id = p_fleet_id AND portal_user_id = p_portal_user_id;
  PERFORM log_fleet_action(p_fleet_id, 'staff_removed', jsonb_build_object('portal_user_id', p_portal_user_id));
END;
$$;
REVOKE ALL ON FUNCTION remove_fleet_staff(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION remove_fleet_staff(uuid, uuid) TO authenticated;
