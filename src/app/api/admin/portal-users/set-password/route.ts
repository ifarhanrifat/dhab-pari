import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Same shape as /api/admin/users/set-password, for a portal (donor/consumer)
// account instead of a staff one — the villager on the other end usually
// has no email to send a reset link to, so an admin sets it directly.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: caller } = await supabase.from('admin_users').select('role, secondary_role').eq('auth_user_id', user.id).single()
  const callerIsSuperAdmin = caller?.role === 'super_admin' || caller?.secondary_role === 'super_admin'
  const callerIsAdmin = caller?.role === 'admin' || caller?.secondary_role === 'admin'
  if (!callerIsSuperAdmin && !callerIsAdmin) {
    return NextResponse.json({ error: 'Only an Admin or Super Admin can reset a portal user’s password.' }, { status: 403 })
  }

  let body: { portalUserId?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { portalUserId, password } = body
  if (!portalUserId || !password || password.length < 8) {
    return NextResponse.json({ error: 'A user and a password of at least 8 characters are required.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: target, error: targetError } = await admin.from('portal_users').select('id, auth_user_id').eq('id', portalUserId).single()
  if (targetError || !target?.auth_user_id) {
    return NextResponse.json({ error: 'User not found or has no login yet.' }, { status: 404 })
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(target.auth_user_id, { password })
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
