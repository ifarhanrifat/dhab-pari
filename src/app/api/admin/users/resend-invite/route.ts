import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin', admin: 'Admin', accountant: 'Accountant',
  water_accountant: 'Water Accountant', donor_accountant: 'Donor Accountant',
  publisher: 'Publisher', viewer: 'Viewer',
}

// Real gap, 2026-09-28: an invite that never arrived (landed in spam, or
// the address was mistyped and corrected) had no way to be re-sent —
// /api/admin/users/invite explicitly refuses any email that already has
// an admin_users row, pending or not, so the only way to retry was a
// direct Supabase admin API call from outside this app entirely (which is
// how the live pakistan001@gmail.com case got unstuck). This is that same
// call, wired to a real button, gated the same way inviting is and only
// for a row that's still genuinely pending (never accepted).
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
  const { data: target } = await admin.from('admin_users').select('email, full_name, role, secondary_role, invite_accepted_at').eq('id', adminUserId).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })
  if (target.invite_accepted_at) {
    return NextResponse.json({ error: 'This invite was already accepted — there is nothing to resend.' }, { status: 409 })
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin
  const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(target.email, {
    data: {
      full_name: target.full_name,
      role: ROLE_LABELS[target.role] ?? target.role,
      secondary_role: target.secondary_role ? (ROLE_LABELS[target.secondary_role] ?? target.secondary_role) : null,
    },
    redirectTo: `${siteUrl}/admin/accept-invite`,
  })
  if (inviteError) {
    // Defense-in-depth: invite_accepted_at is meant to already rule this
    // out above, but a real bug (fixed 2026-09-28) had it silently stuck
    // null on every genuinely-accepted invite for a while, which is
    // exactly what surfaces here as Supabase's own "already registered"
    // error instead of the friendlier one above. Translate it rather than
    // leak the raw GoTrue message, and self-heal the stale bookkeeping
    // while we're here so this stops recurring for this row.
    if (/already.*registered/i.test(inviteError.message)) {
      await admin.from('admin_users').update({ invite_accepted_at: new Date().toISOString() }).eq('id', adminUserId)
      return NextResponse.json({ error: 'This invite was already accepted (the account is active) — the page just had stale info. Refresh and try again.' }, { status: 409 })
    }
    return NextResponse.json({ error: inviteError.message }, { status: 400 })
  }

  await admin.from('admin_users').update({ invited_at: new Date().toISOString() }).eq('id', adminUserId)

  return NextResponse.json({ success: true })
}
