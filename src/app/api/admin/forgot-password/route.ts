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

// Replaces supabase.auth.resetPasswordForEmail()'s clickable magic link —
// see /api/portal/forgot-password's comment for the full story (a link
// gets silently consumed by email security scanners before the real
// person ever clicks it; confirmed live on this exact admin flow for
// saeedazmat80@gmail.com's invite, which is what prompted migrating both
// admin flows to this same code-based pattern, migration 565). Reuses
// portalPasswordResetCodeEmail — its body has nothing portal-specific in
// it, just a generic code notice.
export async function POST(req: NextRequest) {
  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  // Same generic response either way below — never reveal whether an
  // email belongs to a real admin account.
  if (!email) {
    return NextResponse.json({ error: 'Enter your email address.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: adminUser } = await admin.from('admin_users')
    .select('id, auth_user_id, tenant_id, password_reset_requested_at')
    .ilike('email', email)
    .maybeSingle()

  // No matching account, or a pending invite nobody has accepted yet
  // (auth_user_id null) — there's no real login to reset.
  if (!adminUser || !adminUser.auth_user_id) {
    return NextResponse.json({ success: true })
  }

  if (adminUser.password_reset_requested_at) {
    const elapsed = Date.now() - new Date(adminUser.password_reset_requested_at).getTime()
    if (elapsed < COOLDOWN_MS) {
      return NextResponse.json({ success: true })
    }
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  try {
    const tenantName = await getTenantName(admin, adminUser.tenant_id)
    await sendEmail({
      to: email,
      subject: `Your ${tenantName} admin password reset code`,
      html: portalPasswordResetCodeEmail(code, tenantName),
    })
  } catch (err) {
    console.error('admin forgot-password: email send failed', err)
    return NextResponse.json({ success: true })
  }

  await admin.from('admin_users').update({
    password_reset_code: code,
    password_reset_code_expires_at: expiresAt,
    password_reset_requested_at: new Date().toISOString(),
  }).eq('id', adminUser.id)

  return NextResponse.json({ success: true })
}
