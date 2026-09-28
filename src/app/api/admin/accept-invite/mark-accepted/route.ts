import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'

// Real bug found live, 2026-09-28: accept-invite/page.tsx used to write
// invite_accepted_at via the freshly-authenticated user's own client-side
// call — admin_users has no self-service UPDATE policy for a brand-new
// invitee (there's no reason it should), so that write silently failed
// every time (its result was never even checked). The password itself
// still set correctly (that part goes through Supabase Auth directly,
// not this table), so the account genuinely worked — only the
// bookkeeping field stayed stuck null forever, which is what made a
// fully-active admin still show "Pending" in /admin/users indefinitely,
// and made the new Resend Invite button call inviteUserByEmail() on an
// already-confirmed user (Supabase's real error: "A user with this email
// address has already been registered"). Runs with the service-role
// client specifically to sidestep that RLS gap rather than widen it.
export async function POST() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const admin = createAdminClient()
  const { error } = await admin.from('admin_users').update({ invite_accepted_at: new Date().toISOString() }).eq('auth_user_id', user.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
