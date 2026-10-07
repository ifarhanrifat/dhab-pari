import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sendEmail } from '@/lib/email/resend'
import { passwordChangedEmail } from '@/lib/email/passwordChangedEmail'
import { getTenantName, getTenantWhatsapp } from '@/lib/tenant'

// Real ask, 2026-09-27: a password change happened with no email trail at
// all -- "like the professional website use to do". This fires right
// after a successful supabase.auth.updateUser({ password }) on the
// client (portal profile page) -- it can't happen server-side as part of
// that same call, since updateUser() runs entirely client-side and
// RESEND_API_KEY must never reach the browser. Best-effort only: a failed
// notification here should never be reported back as the password change
// itself having failed (it already succeeded by the time this runs).
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: portalUser } = await supabase.from('portal_users').select('email, full_name, tenant_id').eq('auth_user_id', user.id).maybeSingle()
  if (!portalUser?.email) return NextResponse.json({ success: true })

  try {
    const tenantName = await getTenantName(supabase, portalUser.tenant_id)
    const whatsapp = await getTenantWhatsapp(supabase, portalUser.tenant_id)
    await sendEmail({
      to: portalUser.email,
      subject: `Your ${tenantName} portal password was changed`,
      html: passwordChangedEmail(portalUser.full_name, tenantName, whatsapp),
    })
  } catch (err) {
    console.error('notify-password-changed (portal): send failed', err)
  }
  return NextResponse.json({ success: true })
}
