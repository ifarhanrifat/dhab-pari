import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail } from '@/lib/email/resend'
import { adminInviteCodeEmail } from '@/lib/email/adminInviteCodeEmail'
import { getTenantName } from '@/lib/tenant'

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', accountant: 'Accountant',
  water_accountant: 'Water Accountant', donor_accountant: 'Donor Accountant',
  publisher: 'Publisher', viewer: 'Viewer',
}

const CODE_TTL_MS = 60 * 60_000
const COOLDOWN_MS = 60_000

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

// Real gap, 2026-09-28: an invite that never arrived (landed in spam, or
// the address was mistyped and corrected) had no way to be re-sent —
// /api/admin/users/invite explicitly refuses any email that already has
// an admin_users row, pending or not, so the only way to retry was a
// direct Supabase admin API call from outside this app entirely (which is
// how the live pakistan001@gmail.com case got unstuck). This is that same
// call, wired to a real button, gated the same way inviting is and only
// for a row that's still genuinely pending (never accepted).
//
// Rewritten 2026-10-05 to the code-based invite flow (migration 565). A
// row created under the OLD link-based flow already has auth_user_id set
// (the old /invite route set it immediately) even though invite_accepted_at
// is still null — this is exactly the "a scanner silently consumed the
// link" case that prompted this whole rewrite (confirmed live for
// saeedazmat80@gmail.com: email_confirmed_at/last_sign_in_at were set 56
// seconds after invited_at, with no password ever chosen by the real
// person). Any still-pending row with auth_user_id set is unambiguously
// one of these stale pre-migration rows, since the new /invite route never
// sets auth_user_id until a code is actually verified — so resending here
// also deletes that stale, passwordless auth user and clears the link,
// which is what finally lets the new code-based accept flow create a
// clean one.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: caller } = await supabase.from('admin_users').select('role, secondary_role, can_invite_users').eq('auth_user_id', user.id).single()
  const callerIsSuperAdmin = caller?.role === 'super_admin' || caller?.secondary_role === 'super_admin'
  const callerIsAdmin = caller?.role === 'admin' || caller?.secondary_role === 'admin'
  const callerCanInvite = callerIsSuperAdmin || (callerIsAdmin && caller?.can_invite_users)
  if (!callerCanInvite) {
    return NextResponse.json({ error: 'You do not have permission to invite users.' }, { status: 403 })
  }

  let body: { admin_user_id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const adminUserId = body.admin_user_id
  if (!adminUserId) return NextResponse.json({ error: 'Missing admin_user_id.' }, { status: 400 })

  const admin = createAdminClient()
  const { data: target } = await admin.from('admin_users')
    .select('email, full_name, role, secondary_role, invite_accepted_at, auth_user_id, invited_at, tenant_id')
    .eq('id', adminUserId).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  if (target.invite_accepted_at) {
    return NextResponse.json({ error: 'This invite was already accepted — there is nothing to resend.' }, { status: 409 })
  }

  if (target.invited_at) {
    const elapsed = Date.now() - new Date(target.invited_at).getTime()
    if (elapsed < COOLDOWN_MS) {
      return NextResponse.json({ error: 'A code was just sent — wait a moment before resending.' }, { status: 429 })
    }
  }

  // A stray auth user from the old link-based flow (see this route's own
  // comment above) — delete it so the new code can create a clean one.
  if (target.auth_user_id) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(target.auth_user_id)
    if (deleteError && !/not.*found/i.test(deleteError.message)) {
      return NextResponse.json({ error: `Could not clear the stale account before resending: ${deleteError.message}` }, { status: 500 })
    }
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()
  const roleLabel = ROLE_LABELS[target.role] ?? target.role

  try {
    const tenantName = await getTenantName(admin, target.tenant_id)
    await sendEmail({
      to: target.email,
      subject: `Your ${tenantName} admin invite code`,
      html: adminInviteCodeEmail(code, target.full_name, roleLabel, tenantName),
    })
  } catch (err) {
    console.error('resend-invite: email send failed', err)
    return NextResponse.json({ error: 'Could not send the invite email. Please try again.' }, { status: 500 })
  }

  await admin.from('admin_users').update({
    auth_user_id: null,
    invite_code: code,
    invite_code_expires_at: expiresAt,
    invited_at: new Date().toISOString(),
  }).eq('id', adminUserId)

  return NextResponse.json({ success: true })
}
