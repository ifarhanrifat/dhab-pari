import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { portalEmailChangeCodeEmail } from '@/lib/email/portalEmailChangeEmail'
import { getTenantName } from '@/lib/tenant'

const COOLDOWN_MS = 60_000
const CODE_TTL_MS = 15 * 60_000

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Same code-not-link shape as request-whatsapp-change-code, sent to the NEW
// address instead of the current one — see migration 523's own comment for
// why changing the identity anchor itself has to prove control of the new
// value rather than re-confirming the old one.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { newEmail?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const newEmail = body.newEmail?.trim().toLowerCase()
  if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
  }

  const { data: portalUser } = await supabase.from('portal_users')
    .select('id, tenant_id, email_change_requested_at').eq('auth_user_id', user.id).maybeSingle()
  if (!portalUser) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  if (portalUser.email_change_requested_at) {
    const elapsed = Date.now() - new Date(portalUser.email_change_requested_at).getTime()
    if (elapsed < COOLDOWN_MS) {
      return NextResponse.json({ error: 'A code was just sent — wait a moment before requesting another.' }, { status: 429 })
    }
  }

  // Not a hard uniqueness constraint at the DB level, but two accounts
  // sharing one recovery/login email is exactly the confusion a check here
  // avoids — service-role since this reads across every account, not just
  // the caller's own row.
  const admin = createAdminClient()
  const { data: existing } = await admin.from('portal_users').select('id').ilike('email', newEmail).neq('id', portalUser.id).maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'This email is already used by another account.' }, { status: 400 })
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const tenantName = await getTenantName(supabase, portalUser.tenant_id)
    await sendEmail({
      to: newEmail,
      subject: `Confirm this email for your ${tenantName} portal account`,
      html: portalEmailChangeCodeEmail(code, tenantName),
    })
  } catch (err) {
    console.error('request-email-change-code: email send failed', err)
    return NextResponse.json({ error: 'Could not send the confirmation email — try again shortly.' }, { status: 500 })
  }

  await supabase.from('portal_users').update({
    email_change_code: code,
    email_change_code_expires_at: expiresAt,
    email_change_requested_at: new Date().toISOString(),
    pending_email: newEmail,
  }).eq('id', portalUser.id)

  return NextResponse.json({ success: true })
}
