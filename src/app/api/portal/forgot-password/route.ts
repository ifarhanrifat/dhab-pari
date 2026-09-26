import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { portalPasswordResetEmail } from '@/lib/email/portalPasswordResetEmail'

const COOLDOWN_MS = 60_000

function syntheticEmail(mobile: string) {
  return `${mobile.replace(/[^0-9]/g, '')}@portal.dhabpari.local`
}

// Real gap, 2026-09-26: no portal-side password recovery existed at all.
// Can't use supabase.auth.resetPasswordForEmail() directly — a portal
// account's real Supabase Auth identity is a synthetic
// `<mobile>@portal.dhabpari.local` address (see /api/portal/signup),
// never a deliverable mailbox. So this route resolves the caller's real
// email -> portal_users row -> mobile -> synthetic email, generates the
// recovery link itself via the admin API (which does NOT send anything),
// and delivers it via a direct Resend send to the REAL email instead.
export async function POST(req: NextRequest) {
  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  // Same generic response either way below — never reveal whether an
  // email is on file (see admin/forgot-password's identical reasoning).
  if (!email) {
    return NextResponse.json({ error: 'Enter your email address.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: portalUser } = await admin.from('portal_users')
    .select('id, mobile, auth_user_id, password_reset_requested_at')
    .ilike('email', email)
    .maybeSingle()

  // No matching account, or a placeholder row nobody has ever claimed
  // (auth_user_id null — see the claiming logic in /api/portal/signup) —
  // there's no real login to reset. Respond exactly the same as success.
  if (!portalUser || !portalUser.auth_user_id) {
    return NextResponse.json({ success: true })
  }

  if (portalUser.password_reset_requested_at) {
    const elapsed = Date.now() - new Date(portalUser.password_reset_requested_at).getTime()
    if (elapsed < COOLDOWN_MS) {
      // Already sent one moments ago — don't send another, but still the
      // same generic response so this can't be used to probe timing.
      return NextResponse.json({ success: true })
    }
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: syntheticEmail(portalUser.mobile),
    options: { redirectTo: `${siteUrl}/portal/reset-password` },
  })

  if (linkError || !linkData?.properties?.action_link) {
    // Log server-side for us to debug; still nothing account-specific back
    // to the caller.
    console.error('portal forgot-password: generateLink failed', linkError)
    return NextResponse.json({ success: true })
  }

  try {
    await sendEmail({
      to: email,
      subject: 'Reset your Dhab Pari portal password',
      html: portalPasswordResetEmail(linkData.properties.action_link),
    })
  } catch (err) {
    console.error('portal forgot-password: email send failed', err)
    return NextResponse.json({ success: true })
  }

  await admin.from('portal_users').update({ password_reset_requested_at: new Date().toISOString() }).eq('id', portalUser.id)

  return NextResponse.json({ success: true })
}
