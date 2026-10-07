import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sendEmail } from '@/lib/email/resend'
import { portalEmailChangedNoticeEmail } from '@/lib/email/portalEmailChangeEmail'
import { getTenantName } from '@/lib/tenant'

// Confirms the code request-email-change-code sent to the NEW address and,
// only then, commits pending_email onto the live email column — see
// migration 523's comment for why this two-step shape exists. Also
// best-effort notifies the OLD address, same reasoning as
// notify-password-changed.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const code = body.code?.trim()
  if (!code) return NextResponse.json({ error: 'Enter the code.' }, { status: 400 })

  const { data: portalUser } = await supabase.from('portal_users')
    .select('id, email, tenant_id, email_change_code, email_change_code_expires_at, pending_email')
    .eq('auth_user_id', user.id).maybeSingle()
  if (!portalUser) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  if (!portalUser.email_change_code || !portalUser.pending_email) {
    return NextResponse.json({ error: 'Request a code first.' }, { status: 400 })
  }
  if (!portalUser.email_change_code_expires_at || new Date(portalUser.email_change_code_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This code has expired — request a new one.' }, { status: 400 })
  }
  if (portalUser.email_change_code !== code) {
    return NextResponse.json({ error: 'Wrong code.' }, { status: 400 })
  }

  const oldEmail = portalUser.email
  const newEmail = portalUser.pending_email
  const { error } = await supabase.from('portal_users').update({
    email: newEmail,
    email_change_code: null,
    email_change_code_expires_at: null,
    pending_email: null,
  }).eq('id', portalUser.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  if (oldEmail) {
    try {
      const tenantName = await getTenantName(supabase, portalUser.tenant_id)
      await sendEmail({ to: oldEmail, subject: `Your ${tenantName} portal email was changed`, html: portalEmailChangedNoticeEmail(newEmail, tenantName) })
    } catch (err) {
      console.error('confirm-email-change: old-address notice failed', err)
    }
  }

  return NextResponse.json({ success: true, email: newEmail })
}
