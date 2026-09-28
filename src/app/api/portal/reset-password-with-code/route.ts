import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { passwordChangedEmail } from '@/lib/email/passwordChangedEmail'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'

// Pairs with /api/portal/forgot-password's code — this is the only place
// that ever consumes it. Runs entirely server-side via the admin API
// (updateUserById), so unlike the old magic-link flow there is no
// Supabase session/hash to detect at all on the client; the browser never
// needs to be "logged in" as this user for their password to change.
export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string; newPassword?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const code = body.code?.trim()
  const newPassword = body.newPassword

  if (!email || !code) {
    return NextResponse.json({ error: 'Enter the code sent to your email.' }, { status: 400 })
  }
  if (!newPassword || !passwordMeetsPolicy(newPassword)) {
    return NextResponse.json({ error: 'Password does not meet the requirements (12+ characters, uppercase, lowercase, a number, and a special character).' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: portalUser } = await admin.from('portal_users')
    .select('id, auth_user_id, full_name, password_reset_code, password_reset_code_expires_at')
    .ilike('email', email)
    .maybeSingle()

  // Same generic-sounding failure for "no such account", "wrong code" and
  // "expired code" — no reason to tell an attacker which one it was.
  const invalid = { error: 'That code is wrong or has expired. Request a new one.' }

  if (!portalUser || !portalUser.auth_user_id || !portalUser.password_reset_code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (portalUser.password_reset_code !== code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (!portalUser.password_reset_code_expires_at || new Date(portalUser.password_reset_code_expires_at).getTime() < Date.now()) {
    return NextResponse.json(invalid, { status: 400 })
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(portalUser.auth_user_id, { password: newPassword })
  if (updateError) {
    // A rejected password (too weak for whatever policy Supabase Auth is
    // configured with) is a client input problem, not a server fault —
    // surfacing Supabase's own message is more useful here than a generic
    // "8 characters" hint that might not match the project's real policy.
    return NextResponse.json({ error: updateError.message }, { status: 400 })
  }

  // One-time use — clear it immediately so this exact code can't be
  // replayed even within its own expiry window.
  await admin.from('portal_users').update({ password_reset_code: null, password_reset_code_expires_at: null }).eq('id', portalUser.id)

  try {
    await sendEmail({
      to: email,
      subject: 'Your Dhab Pari portal password was changed',
      html: passwordChangedEmail(portalUser.full_name),
    })
  } catch (err) {
    console.error('reset-password-with-code: notification send failed', err)
  }

  return NextResponse.json({ success: true })
}
