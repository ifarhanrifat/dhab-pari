import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

const VALID_ROLES = ['super_admin', 'admin', 'accountant', 'water_accountant', 'donor_accountant', 'publisher', 'viewer']

export async function POST(req: NextRequest) {
  // Verify the caller is an authenticated super_admin, or an admin with the
  // invite_users grant, before doing anything privileged.
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: caller } = await supabase.from('admin_users').select('role, can_invite_users').eq('auth_user_id', user.id).single()
  const callerCanInvite = caller?.role === 'super_admin' || (caller?.role === 'admin' && caller.can_invite_users)
  if (!callerCanInvite) {
    return NextResponse.json({ error: 'You do not have permission to invite users.' }, { status: 403 })
  }

  let body: {
    email?: string; full_name?: string; role?: string
    can_post_transactions?: boolean; can_edit_transactions?: boolean; can_delete_transactions?: boolean
    can_view_reports?: boolean; can_approve_transactions?: boolean
    can_manage_parties?: boolean; can_manage_accounts?: boolean; can_edit_accounts?: boolean; can_delete_accounts?: boolean
    can_restore_deleted?: boolean; can_invite_users?: boolean
    access_water_supply?: boolean; access_donors_projects?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const fullName = body.full_name?.trim()
  const role = body.role

  if (!email || !fullName || !role || !VALID_ROLES.includes(role)) {
    return NextResponse.json({ error: 'Email, full name, and a valid role are required.' }, { status: 400 })
  }

  // Only a super admin may grant the super_admin role — an admin (even one with
  // invite_users) can never create another super admin, including promoting itself.
  if (role === 'super_admin' && caller?.role !== 'super_admin') {
    return NextResponse.json({ error: 'Only a Super Admin can grant the Super Admin role.' }, { status: 403 })
  }

  const admin = createAdminClient()
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${siteUrl}/admin/accept-invite`,
  })

  if (inviteError) {
    return NextResponse.json({ error: inviteError.message }, { status: 400 })
  }

  const { error: upsertError } = await admin.from('admin_users').upsert({
    email, full_name: fullName, role, is_active: true,
    auth_user_id: invited.user.id,
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
    access_donors_projects: !!body.access_donors_projects,
    invited_at: new Date().toISOString(),
  }, { onConflict: 'email' })

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
