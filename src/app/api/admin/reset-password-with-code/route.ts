import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { passwordChangedEmail } from '@/lib/email/passwordChangedEmail'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'
import { getTenantName, getTenantWhatsapp } from '@/lib/tenant'

// Pairs with /api/admin/forgot-password's code — this is the only place
// that ever consumes it. Runs entirely server-side via the admin API
// (updateUserById), so there is no Supabase session/hash to detect on the
// client at all. Mirrors /api/portal/reset-password-with-code exactly.
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
  const { data: adminUser } = await admin.from('admin_users')
    .select('id, auth_user_id, full_name, tenant_id, password_reset_code, password_reset_code_expires_at')
    .ilike('email', email)
    .maybeSingle()

  const invalid = { error: 'That code is wrong or has expired. Request a new one.' }

  if (!adminUser || !adminUser.auth_user_id || !adminUser.password_reset_code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (adminUser.password_reset_code !== code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (!adminUser.password_reset_code_expires_at || new Date(adminUser.password_reset_code_expires_at).getTime() < Date.now()) {
    return NextResponse.json(invalid, { status: 400 })
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(adminUser.auth_user_id, { password: newPassword })
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 })
  }

  // One-time use — clear it immediately so this exact code can't be
  // replayed even within its own expiry window.
  await admin.from('admin_users').update({ password_reset_code: null, password_reset_code_expires_at: null }).eq('id', adminUser.id)

  try {
    const tenantName = await getTenantName(admin, adminUser.tenant_id)
    const whatsapp = await getTenantWhatsapp(admin, adminUser.tenant_id)
    await sendEmail({
      to: email,
      subject: `Your ${tenantName} admin password was changed`,
      html: passwordChangedEmail(adminUser.full_name, tenantName, whatsapp),
    })
  } catch (err) {
    console.error('admin reset-password-with-code: notification send failed', err)
  }

  return NextResponse.json({ success: true })
}
