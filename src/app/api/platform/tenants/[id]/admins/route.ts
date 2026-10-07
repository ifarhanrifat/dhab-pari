import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'

// Creating a tenant's first (or an additional) admin needs a real Supabase
// Auth user to exist first — platform_create_tenant_admin (migration 619)
// deliberately takes an existing auth_user_id rather than creating one
// itself, same "insert, don't provision auth" convention as every other
// SECURITY DEFINER function in this codebase. This route is the one place
// that does the auth-user creation (service role, same as
// /api/admin/users/create-manual), then calls that RPC through the
// caller's OWN session so is_platform_admin() resolves correctly inside it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: tenantId } = await params
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: isPlatformAdmin } = await supabase.rpc('is_platform_admin')
  if (!isPlatformAdmin) {
    return NextResponse.json({ error: 'Not authorized.' }, { status: 403 })
  }

  let body: { email?: string; full_name?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const fullName = body.full_name?.trim()
  const password = body.password

  if (!email || !fullName) {
    return NextResponse.json({ error: 'Email and full name are required.' }, { status: 400 })
  }
  if (!password || !passwordMeetsPolicy(password)) {
    return NextResponse.json(
      { error: 'Password does not meet the requirements (12+ characters, uppercase, lowercase, a number, and a special character).' },
      { status: 400 }
    )
  }

  const admin = createAdminClient()

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, role: 'Super Admin' },
  })
  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 400 })
  }

  // Through the caller's own session, not the service-role client — the
  // RPC's own is_platform_admin() check needs auth.uid() to resolve to the
  // calling platform admin.
  const { data: adminUserId, error: rpcError } = await supabase.rpc('platform_create_tenant_admin', {
    p_tenant_id: tenantId,
    p_auth_user_id: created.user.id,
    p_full_name: fullName,
    p_email: email,
  })

  if (rpcError) {
    // Roll back the auth user we just created rather than leaving an
    // orphaned login with no admin_users row behind it.
    await admin.auth.admin.deleteUser(created.user.id)
    return NextResponse.json({ error: rpcError.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, admin_user_id: adminUserId })
}
