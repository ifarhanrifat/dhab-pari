import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Deletes a portal (donor/consumer) account outright — for dummy/test
// signups, or a genuine account-removal request. Deleting the auth.users
// row cascades to portal_users automatically (migration 121:
// auth_user_id ... ON DELETE CASCADE); a row with no auth_user_id yet
// (an incomplete/never-finished signup) is just deleted directly.
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
    return NextResponse.json({ error: 'Only an Admin or Super Admin can delete a portal account.' }, { status: 403 })
  }

  let body: { portalUserId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!body.portalUserId) return NextResponse.json({ error: 'Missing portalUserId.' }, { status: 400 })

  const admin = createAdminClient()
  const { data: target } = await admin.from('portal_users').select('auth_user_id').eq('id', body.portalUserId).single()

  if (target?.auth_user_id) {
    const { error } = await admin.auth.admin.deleteUser(target.auth_user_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await admin.from('portal_users').delete().eq('id', body.portalUserId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
