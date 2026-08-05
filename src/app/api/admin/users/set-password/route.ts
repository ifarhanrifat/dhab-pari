import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Resets an existing user's password directly — covers accounts stuck from a
// broken invite/reset-password email, and keeps the viewable copy (in
// admin_user_credentials) in sync with whatever was just set.
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
  if (!callerIsSuperAdmin) {
    return NextResponse.json({ error: 'Only a Super Admin can reset a password directly.' }, { status: 403 })
  }

  let body: { adminUserId?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const { adminUserId, password } = body
  if (!adminUserId || !password || password.length < 8) {
    return NextResponse.json({ error: 'A user and a password of at least 8 characters are required.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: target, error: targetError } = await admin.from('admin_users').select('id, auth_user_id').eq('id', adminUserId).single()
  if (targetError || !target?.auth_user_id) {
    return NextResponse.json({ error: 'User not found or has no login yet.' }, { status: 404 })
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(target.auth_user_id, { password })
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 })
  }

  await admin.from('admin_user_credentials').upsert({
    admin_user_id: target.id, password, updated_at: new Date().toISOString(),
  }, { onConflict: 'admin_user_id' })

  return NextResponse.json({ success: true })
}
