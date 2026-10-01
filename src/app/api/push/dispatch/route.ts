import { NextRequest, NextResponse } from 'next/server'
import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'
import { getFirebaseMessaging } from '@/lib/firebaseAdmin'

// Called by the dispatch_push_notification() Postgres trigger (migration
// 348) right after a row lands in `notifications` or `portal_notifications`.
// The actual Web Push cryptography (VAPID signing, payload encryption) is
// squarely a Node job — this is the one place it happens, never client-side
// (that would mean shipping the private key to the browser).
//
// Fire-and-forget from Postgres's side: the trigger doesn't wait on this
// route's response, so a slow push service or a dead subscription here
// never holds up the notification insert itself.
//
// setVapidDetails() is called inside the handler, not up here at module
// scope — Next.js evaluates every route module during the build's page-
// data-collection step (to figure out which routes are dynamic), so a
// top-level call throws at BUILD time, not request time, the moment any
// one of the three VAPID env vars is missing — which took down the whole
// site's build, not just this one feature, until this was moved.

interface DispatchBody {
  table: 'notifications' | 'portal_notifications'
  id: string
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.PUSH_TRIGGER_SECRET}`) {
    // TEMPORARY diagnostic, 2026-10-02 — revert once the env var mismatch
    // behind repeated 401s is found. Never reveals the actual secret.
    return NextResponse.json({
      error: 'Unauthorized',
      debug: {
        envSecretLen: process.env.PUSH_TRIGGER_SECRET?.length ?? null,
        receivedLen: auth?.length ?? null,
        receivedPrefix: auth?.slice(0, 10) ?? null,
      },
    }, { status: 401 })
  }

  const { VAPID_SUBJECT, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env
  if (!VAPID_SUBJECT || !NEXT_PUBLIC_VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    // Push notifications are genuinely optional — the trigger that calls
    // this route doesn't wait on the response, so failing loudly here just
    // means this one delivery is skipped, never that anything else breaks.
    return NextResponse.json({ error: 'Push notifications are not configured (missing VAPID env vars).' }, { status: 503 })
  }
  webpush.setVapidDetails(VAPID_SUBJECT, NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

  const { table, id } = (await req.json()) as DispatchBody
  if (table !== 'notifications' && table !== 'portal_notifications') {
    return NextResponse.json({ error: 'Unknown table' }, { status: 400 })
  }

  const supabase = createAdminClient()
  // Selected columns differ per table — notifications has recipient_id,
  // portal_notifications has portal_user_id, and asking PostgREST for a
  // column that doesn't exist on the table fails the whole query (returning
  // data: null), which used to be silently misread here as "no such row".
  const ownerColumn = table === 'notifications' ? 'recipient_id' : 'portal_user_id'
  const { data: row, error: rowError } = await supabase.from(table).select(`id, title, body, link, ${ownerColumn}`).eq('id', id).maybeSingle()
  if (rowError) return NextResponse.json({ error: rowError.message }, { status: 500 })
  if (!row) return NextResponse.json({ ok: true, note: 'row not found' })

  const recipientId = (row as unknown as Record<string, string>)[ownerColumn]
  // push_subscriptions names its owner columns admin_user_id/portal_user_id
  // — different from notifications.recipient_id, so this is a second,
  // separate mapping, not the same ownerColumn reused.
  const subsColumn = table === 'notifications' ? 'admin_user_id' : 'portal_user_id'

  const payload = JSON.stringify({ title: row.title, body: row.body ?? '', link: row.link ?? '/' })

  const { data: subs } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq(subsColumn, recipientId)
  const webPushResults = await Promise.allSettled(
    (subs ?? []).map((s) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      ).catch(async (err) => {
        // 404/410 means the browser has permanently dropped this
        // subscription (uninstalled, permission revoked, etc.) — clean it
        // up rather than retrying it forever.
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('id', s.id)
        }
        throw err
      })
    )
  )

  // Native Android app (a bare WebView) can't receive Web Push in the
  // background — fcm_device_tokens (558) is that app's own registration,
  // delivered through Firebase instead. Same payload, a second real
  // delivery path, not a replacement for the one above (a browser install
  // or iOS Home Screen app still uses Web Push, same as before).
  const messaging = getFirebaseMessaging()
  const { data: fcmTokens } = messaging
    ? await supabase.from('fcm_device_tokens').select('id, token').eq(subsColumn, recipientId)
    : { data: null }
  const fcmResults = messaging
    ? await Promise.allSettled(
        (fcmTokens ?? []).map((t) =>
          messaging.send({
            token: t.token,
            notification: { title: row.title, body: row.body ?? '' },
            data: { link: row.link ?? '/' },
          }).catch(async (err) => {
            // The FCM-side equivalent of a 404/410 — the app was
            // uninstalled or the token rotated, so this one is dead.
            if (err?.code === 'messaging/registration-token-not-registered' || err?.code === 'messaging/invalid-registration-token') {
              await supabase.from('fcm_device_tokens').delete().eq('id', t.id)
            }
            throw err
          })
        )
      )
    : []

  const results = [...webPushResults, ...fcmResults]
  if (!subs?.length && !fcmTokens?.length) return NextResponse.json({ ok: true, note: 'no subscriptions' })
  return NextResponse.json({ ok: true, sent: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length })
}
