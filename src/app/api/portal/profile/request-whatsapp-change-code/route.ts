import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { portalWhatsappChangeCodeEmail } from '@/lib/email/portalWhatsappChangeEmail'
import { getTenantName } from '@/lib/tenant'

const COOLDOWN_MS = 60_000
const CODE_TTL_MS = 15 * 60_000

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Real ask, 2026-09-29: whatsapp_number had no confirmation step at all —
// see migration 521's own comment. Same code-not-link shape as portal
// password reset (514): a 6-digit code emailed to whatever address is
// already on file, required before confirm-whatsapp-change actually
// writes the new number. Requires an authenticated session (this changes
// the caller's own account only, never looked up by phone/email the way
// the anonymous forgot-password route has to be).
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { newWhatsappNumber?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const newWhatsappNumber = body.newWhatsappNumber?.trim()
  if (!newWhatsappNumber) {
    return NextResponse.json({ error: 'Enter the new WhatsApp number.' }, { status: 400 })
  }

  const { data: portalUser } = await supabase.from('portal_users')
    .select('id, email, tenant_id, whatsapp_change_requested_at')
    .eq('auth_user_id', user.id).maybeSingle()
  if (!portalUser) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
  if (!portalUser.email) {
    return NextResponse.json({ error: 'Add an email to your profile first — the confirmation code is sent there.' }, { status: 400 })
  }

  if (portalUser.whatsapp_change_requested_at) {
    const elapsed = Date.now() - new Date(portalUser.whatsapp_change_requested_at).getTime()
    if (elapsed < COOLDOWN_MS) {
      return NextResponse.json({ error: 'A code was just sent — wait a moment before requesting another.' }, { status: 429 })
    }
  }

  // Real ask, 2026-09-29: warn before sending a code at all if this number
  // is already someone else's, rather than letting the whole flow succeed
  // and only failing (or worse, silently overwriting) at confirm time.
  const admin = createAdminClient()
  const { data: existing } = await admin.from('portal_users').select('id').eq('whatsapp_number', newWhatsappNumber).neq('id', portalUser.id).maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'This WhatsApp number is already registered to another account — use a different number.' }, { status: 400 })
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const tenantName = await getTenantName(supabase, portalUser.tenant_id)
    await sendEmail({
      to: portalUser.email,
      subject: `Confirm your new ${tenantName} WhatsApp number`,
      html: portalWhatsappChangeCodeEmail(code, newWhatsappNumber, tenantName),
    })
  } catch (err) {
    console.error('request-whatsapp-change-code: email send failed', err)
    return NextResponse.json({ error: 'Could not send the confirmation email — try again shortly.' }, { status: 500 })
  }

  await supabase.from('portal_users').update({
    whatsapp_change_code: code,
    whatsapp_change_code_expires_at: expiresAt,
    whatsapp_change_requested_at: new Date().toISOString(),
    pending_whatsapp_number: newWhatsappNumber,
  }).eq('id', portalUser.id)

  return NextResponse.json({ success: true })
}
