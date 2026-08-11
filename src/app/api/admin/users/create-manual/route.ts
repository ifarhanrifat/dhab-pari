import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

const VALID_ROLES = ['super_admin', 'admin', 'accountant', 'water_accountant', 'donor_accountant', 'publisher', 'viewer']

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  accountant: 'Accountant',
  water_accountant: 'Water Accountant',
  donor_accountant: 'Donor Accountant',
  publisher: 'Publisher',
  viewer: 'Viewer',
}

// Bridge for when invite emails aren't reaching people (Supabase free-tier
// limits) — creates a working login immediately with a chosen password
// instead of relying on the invite email. Super-admin only: stricter than
// the invite route's admin+can_invite_users allowance, since this both sets
// and keeps a viewable copy of someone's real password.
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
    return NextResponse.json({ error: 'Only a Super Admin can create a user directly.' }, { status: 403 })
  }

  let body: {
    email?: string; full_name?: string; role?: string; secondary_role?: string | null; password?: string
    can_post_transactions?: boolean; can_edit_transactions?: boolean; can_delete_transactions?: boolean
    can_view_reports?: boolean; can_approve_transactions?: boolean
    can_manage_parties?: boolean; can_manage_accounts?: boolean; can_edit_accounts?: boolean; can_delete_accounts?: boolean
    can_restore_deleted?: boolean; can_invite_users?: boolean
    access_water_supply?: boolean; access_donors_projects?: boolean
    can_publish_news?: boolean; can_publish_videos?: boolean; can_publish_gallery?: boolean
    can_publish_ticker?: boolean; can_publish_jobs?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const fullName = body.full_name?.trim()
  const role = body.role
  const secondaryRole = body.secondary_role?.trim() || null
  const password = body.password

  if (!email || !fullName || !role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: 'Email, full name, and a valid role are required.' }, { status: 400 })
  }
  if (!password || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
  }
  if (secondaryRole && (!VALID_ROLES.includes(secondaryRole) || secondaryRole === role)) {
    return NextResponse.json({ error: 'Secondary role must be a different valid role.' }, { status: 400 })
  }

  const admin = createAdminClient()

  const { data: existing } = await admin.from('admin_users').select('role, is_active').eq('email', email).maybeSingle()
  if (existing) {
    const status = existing.is_active ? 'active' : 'deactivated'
    return NextResponse.json({
      error: `${email} already has an account (${ROLE_LABELS[existing.role] ?? existing.role}, ${status}). Use Reset Password on their existing account instead.`,
    }, { status: 409 })
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: fullName, role: ROLE_LABELS[role] ?? role, secondary_role: secondaryRole ? (ROLE_LABELS[secondaryRole] ?? secondaryRole) : null },
  })
  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 400 })
  }

  const { data: adminUserRow, error: upsertError } = await admin.from('admin_users').upsert({
    email, full_name: fullName, role, secondary_role: secondaryRole, is_active: true,
    auth_user_id: created.user.id,
    can_post_transactions: !!body.can_post_transactions,
    can_edit_transactions: !!body.can_edit_transactions,
    can_delete_transactions: !!body.can_delete_transactions,
    can_view_reports: !!body.can_view_reports,
    can_approve_transactions: !!body.can_approve_transactions,
    can_manage_parties: !!body.can_manage_parties,
    can_manage_accounts: !!body.can_manage_accounts,
    can_edit_accounts: !!body.can_edit_accounts,
    can_delete_accounts: !!body.can_delete_accounts,
    can_restore_deleted: !!body.can_restore_deleted,
    can_invite_users: !!body.can_invite_users,
    access_water_supply: !!body.access_water_supply,
    can_publish_news: !!body.can_publish_news,
    can_publish_videos: !!body.can_publish_videos,
    can_publish_gallery: !!body.can_publish_gallery,
    can_publish_ticker: !!body.can_publish_ticker,
    can_publish_jobs: !!body.can_publish_jobs,
    access_donors_projects: !!body.access_donors_projects,
    invited_at: new Date().toISOString(),
    invite_accepted_at: new Date().toISOString(),
  }, { onConflict: 'email' }).select('id').single()

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  await admin.from('admin_user_credentials').upsert({
    admin_user_id: adminUserRow.id, password, updated_at: new Date().toISOString(),
  }, { onConflict: 'admin_user_id' })

  return NextResponse.json({ success: true })
}
