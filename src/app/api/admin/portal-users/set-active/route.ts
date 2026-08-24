import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Blocking a portal account used to just flip portal_users.is_active, which
// only takes effect the next time something checks current_portal_user_id()
// (RLS on a gated table, or the /portal middleware's own cache — up to a
// 10-minute lag). A currently open session kept working regardless, and any
// RLS policy that forgot to consult current_portal_user_id() (found: two of
// them, migration 321) wasn't gated by is_active at all. Banning the
// underlying auth.users row makes Supabase Auth itself reject that session
// on its very next getUser() revalidation — immediate, and independent of
// any cache or RLS policy this app writes. is_active stays in sync too,
// since RLS/UI still reads it directly.
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
    return NextResponse.json({ error: 'Only an Admin or Super Admin can block a portal account.' }, { status: 403 })
  }

  let body: { portalUserId?: string; active?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  if (!body.portalUserId || typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'Missing portalUserId or active.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: target } = await admin.from('portal_users').select('auth_user_id').eq('id', body.portalUserId).single()

  const { error: updateError } = await admin.from('portal_users').update({ is_active: body.active }).eq('id', body.portalUserId)
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  if (target?.auth_user_id) {
    const { error: banError } = await admin.auth.admin.updateUserById(target.auth_user_id, {
      ban_duration: body.active ? 'none' : '876000h', // ~100 years — GoTrue has no "forever" literal
    })
    if (banError) return NextResponse.json({ error: banError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
