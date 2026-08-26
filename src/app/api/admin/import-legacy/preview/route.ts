import { NextRequest, NextResponse } from 'next/server'
import { parseBookKeeperDb } from '@/lib/legacyImport/parseBookKeeper'
import { createClient } from '@/lib/supabase/server'

// Read-only — parses the uploaded file and returns exactly what would be
// imported, without writing anything. The commit route (below) receives
// this same JSON back from the client (plus any edits) rather than the
// raw file again, so there's one parse, one source of truth for what the
// admin actually reviewed before confirming.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: admin } = await supabase.from('admin_users').select('role').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
  if (admin?.role !== 'super_admin') return NextResponse.json({ error: 'Super admin only' }, { status: 403 })

  const form = await req.formData()
  const file = form.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const data = await parseBookKeeperDb(buffer)
    return NextResponse.json(data)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not read this file as a BookKeeper database.' }, { status: 400 })
  }
}
