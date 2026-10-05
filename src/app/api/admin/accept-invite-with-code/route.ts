import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { passwordMeetsPolicy } from '@/lib/passwordPolicy'

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', accountant: 'Accountant',
  water_accountant: 'Water Accountant', donor_accountant: 'Donor Accountant',
  publisher: 'Publisher', viewer: 'Viewer',
}

// Pairs with /api/admin/users/invite and /resend-invite's code (migration
// 565). Runs entirely server-side via the admin API (createUser), so
// there is no Supabase session/hash to detect on the client at all — the
// Supabase auth user for this admin doesn't even exist until this request
// succeeds. Requiring auth_user_id to still be null is what keeps this
// safe against a stale pre-migration row (one invited under the old
// link-based flow, which already has auth_user_id set): that row's
// invite_code is also still null until a super admin clicks Resend Invite,
// which is the only thing that clears the stale auth_user_id and issues a
// real code — so this route can never collide with Supabase's own
// "already registered" refusal.
export async function POST(req: NextRequest) {
  let body: { email?: string; code?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }

  const email = body.email?.trim().toLowerCase()
  const code = body.code?.trim()
  const password = body.password

  if (!email || !code) {
    return NextResponse.json({ error: 'Enter the code sent to your email.' }, { status: 400 })
  }
  if (!password || !passwordMeetsPolicy(password)) {
    return NextResponse.json({ error: 'Password does not meet the requirements (12+ characters, uppercase, lowercase, a number, and a special character).' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: row } = await admin.from('admin_users')
    .select('id, full_name, role, secondary_role, invite_code, invite_code_expires_at, invite_accepted_at, auth_user_id')
    .ilike('email', email)
    .maybeSingle()

  // Same generic failure for "no such invite", "already accepted", "stale
  // pre-migration row waiting on a resend", "wrong code" and "expired
  // code" — no reason to tell anyone which one it was.
  const invalid = { error: 'That code is wrong or has expired. Ask your administrator to resend the invite.' }

  if (!row || row.invite_accepted_at || row.auth_user_id || !row.invite_code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (row.invite_code !== code) {
    return NextResponse.json(invalid, { status: 400 })
  }
  if (!row.invite_code_expires_at || new Date(row.invite_code_expires_at).getTime() < Date.now()) {
    return NextResponse.json(invalid, { status: 400 })
  }

  const roleLabel = ROLE_LABELS[row.role] ?? row.role
  const secondaryRoleLabel = row.secondary_role ? (ROLE_LABELS[row.secondary_role] ?? row.secondary_role) : null

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: row.full_name, role: roleLabel, secondary_role: secondaryRoleLabel },
  })
  if (createError || !created?.user) {
    return NextResponse.json({ error: createError?.message ?? 'Could not create your account.' }, { status: 400 })
  }

  await admin.from('admin_users').update({
    auth_user_id: created.user.id,
    invite_accepted_at: new Date().toISOString(),
    invite_code: null,
    invite_code_expires_at: null,
  }).eq('id', row.id)

  return NextResponse.json({ success: true })
}
