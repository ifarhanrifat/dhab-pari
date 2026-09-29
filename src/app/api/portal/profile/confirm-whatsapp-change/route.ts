import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// Confirms the code request-whatsapp-change-code sent and, only then,
// actually writes pending_whatsapp_number onto the live whatsapp_number
// column — see migration 521's comment for why this two-step shape exists.
export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 })
  }
  const code = body.code?.trim()
  if (!code) return NextResponse.json({ error: 'Enter the code.' }, { status: 400 })

  const { data: portalUser } = await supabase.from('portal_users')
    .select('id, whatsapp_change_code, whatsapp_change_code_expires_at, pending_whatsapp_number')
    .eq('auth_user_id', user.id).maybeSingle()
  if (!portalUser) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  if (!portalUser.whatsapp_change_code || !portalUser.pending_whatsapp_number) {
    return NextResponse.json({ error: 'Request a code first.' }, { status: 400 })
  }
  if (!portalUser.whatsapp_change_code_expires_at || new Date(portalUser.whatsapp_change_code_expires_at) < new Date()) {
    return NextResponse.json({ error: 'This code has expired — request a new one.' }, { status: 400 })
  }
  if (portalUser.whatsapp_change_code !== code) {
    return NextResponse.json({ error: 'Wrong code.' }, { status: 400 })
  }

  const { error } = await supabase.from('portal_users').update({
    whatsapp_number: portalUser.pending_whatsapp_number,
    whatsapp_change_code: null,
    whatsapp_change_code_expires_at: null,
    pending_whatsapp_number: null,
  }).eq('id', portalUser.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, whatsappNumber: portalUser.pending_whatsapp_number })
}
