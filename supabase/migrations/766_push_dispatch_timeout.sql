-- Migration 766: real bug found live, 2026-10-29 — after fixing the
-- fcm_device_tokens registration bug (765 was the complete_trip_booking
-- fix; this is the actual next one), a real end-to-end ride-dispatch
-- test STILL didn't deliver a push. Root-caused via net._http_response
-- (pg_net's own request log): the dispatch_push_notification() trigger
-- calls net.http_post() with its default 5-second timeout, and the
-- /api/push/dispatch Vercel function — which cold-starts the Firebase
-- Admin SDK on top of Next.js's own cold start — routinely takes longer
-- than that on a cold invocation. Confirmed directly: the request for
-- this exact test ("Timeout of 5000 ms reached... HTTP Request/Response
-- time: 4557.871000 ms") never got a response in time, while a later
-- request (once the function was warm) completed in well under a
-- second with {"ok":true,"sent":1,"failed":0}. 2 of the last 7 logged
-- attempts timed out this same way — a real, recurring issue, not a
-- one-off. net.http_post's own timeout_milliseconds parameter is the
-- fix (no Vercel-side change needed): 5000 -> 15000, generous headroom
-- for a cold start without meaningfully delaying real notifications,
-- since this call is already fire-and-forget from Postgres's side.

CREATE OR REPLACE FUNCTION dispatch_push_notification() RETURNS trigger AS $$
DECLARE
  v_url text;
  v_secret text;
  v_table text := TG_TABLE_NAME;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'push_api_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'push_trigger_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := jsonb_build_object('table', v_table, 'id', NEW.id),
    timeout_milliseconds := 15000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a push-dispatch problem block the notification itself.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault, net;
