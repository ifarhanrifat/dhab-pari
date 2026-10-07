import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { portalPasswordResetCodeEmail } from '@/lib/email/portalPasswordResetEmail'
import { getTenantName } from '@/lib/tenant'

const COOLDOWN_MS = 60_000
const CODE_TTL_MS = 15 * 60_000

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Real gap, 2026-09-26, switched to a code 2026-09-27: no portal-side
// password recovery existed at all. First built as a Supabase magic-link
// (generateLink + direct Resend send, since a portal account's real
// Supabase Auth identity is a synthetic <mobile>@portal.dhabpari.local
// address -- never a deliverable mailbox, so resetPasswordForEmail()
// can't be pointed at it directly). That link kept failing in the field
// -- confirmed a genuinely fresh, valid token reading "expired" by the
// time the real user clicked it, consistent with an email security
// scanner pre-fetching the one-time link, or the user (reasonably)
// opening an older email among several requests, each of which
// invalidates the last. A typed-in code has nothing for a scanner to
// consume and no "which email is current" ambiguity, and fully sidesteps
// Supabase's own redirect_to/session-detection quirks — this exchange is
// now a plain server API call, no magic-link machinery involved.
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
    .select('id, auth_user_id, tenant_id, password_reset_requested_at')
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

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const tenantName = await getTenantName(admin, portalUser.tenant_id)
    await sendEmail({
      to: email,
      subject: `Your ${tenantName} portal password reset code`,
      html: portalPasswordResetCodeEmail(code, tenantName),
    })
  } catch (err) {
    console.error('portal forgot-password: email send failed', err)
    return NextResponse.json({ success: true })
  }

  await admin.from('portal_users').update({
    password_reset_code: code,
    password_reset_code_expires_at: expiresAt,
    password_reset_requested_at: new Date().toISOString(),
  }).eq('id', portalUser.id)

  return NextResponse.json({ success: true })
}
