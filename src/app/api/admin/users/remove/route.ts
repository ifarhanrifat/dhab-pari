import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: caller } = await supabase.from('admin_users').select('role, can_invite_users').eq('auth_user_id', user.id).single()
  const callerCanManageUsers = caller?.role === 'super_admin' || (caller?.role === 'admin' && caller.can_invite_users)
  if (!callerCanManageUsers) {
    return NextResponse.json({ error: 'You do not have permission to remove users.' }, { status: 403 })
  }

  let body: { adminUserId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!body.adminUserId) return NextResponse.json({ error: 'Missing adminUserId.' }, { status: 400 })

  const admin = createAdminClient()
  const { data: target } = await admin.from('admin_users').select('auth_user_id, role').eq('id', body.adminUserId).single()

  if (target?.auth_user_id === user.id) {
    return NextResponse.json({ error: 'You cannot remove your own account.' }, { status: 400 })
  }
  // An admin (even with invite_users) can never remove a super admin — that
  // power stays exclusive to other super admins.
  if (target?.role === 'super_admin' && caller?.role !== 'super_admin') {
    return NextResponse.json({ error: 'Only a Super Admin can remove another Super Admin.' }, { status: 403 })
  }

  if (target?.auth_user_id) {
    await admin.auth.admin.deleteUser(target.auth_user_id)
  }

  const { error } = await admin.from('admin_users').delete().eq('id', body.adminUserId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
