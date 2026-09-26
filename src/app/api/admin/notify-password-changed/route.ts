import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { sendEmail } from '@/lib/email/resend'
import { passwordChangedEmail } from '@/lib/email/passwordChangedEmail'

// Same reasoning as the portal version of this route: fires client-side
// right after a successful supabase.auth.updateUser({ password }) on
// /admin/profile — best-effort, never reported as the password change
// itself failing.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: adminUser } = await supabase.from('admin_users').select('email, full_name').eq('auth_user_id', user.id).maybeSingle()
  if (!adminUser?.email) return NextResponse.json({ success: true })

  try {
    await sendEmail({
      to: adminUser.email,
      subject: 'Your Dhab Pari admin password was changed',
      html: passwordChangedEmail(adminUser.full_name),
    })
  } catch (err) {
    console.error('notify-password-changed (admin): send failed', err)
  }
  return NextResponse.json({ success: true })
}
