import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { LegacyDonation, LegacyExpense, LegacyExpenseReversal, LegacyProject } from '@/lib/legacyImport/parseBookKeeper'

// Runs as the logged-in admin's own session (not a service-role bypass) —
// import_legacy_project/donation/expense (migration 350) check
// current_admin_role() = 'super_admin' themselves, and confirmed_by /
// imported_by need a real admin id to attribute to, not a phantom
// service account.
//
// Called once per small batch from the client (not all ~700 records in one
// request) — a single request looping over everything risks a hosting
// platform's function timeout on a serverless host, with no way to know in
// advance what that limit is. Batching also gives the admin a real,
// incremental progress bar instead of one long silent wait.

function inferCategory(title: string): string {
  if (title.includes('میڈیکل') || title.includes('طبی')) return 'health'
  if (title.includes('کمیٹی اکاؤنٹ') || title.includes('کیمرہ')) return 'other'
  return 'infrastructure'
}

type Body =
  | { phase: 'projects'; items: LegacyProject[] }
  | { phase: 'donations'; items: LegacyDonation[] }
  | { phase: 'expenses'; items: LegacyExpense[] }
  | { phase: 'expenseReversals'; items: LegacyExpenseReversal[] }

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { data: admin } = await supabase.from('admin_users').select('role').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
  if (admin?.role !== 'super_admin') return NextResponse.json({ error: 'Super admin only' }, { status: 403 })

  const body = (await req.json()) as Body
  const errors: string[] = []
  let imported = 0

  if (body.phase === 'projects') {
    for (const p of body.items) {
      const { error } = await supabase.rpc('import_legacy_project', {
        p_external_ref: `bookkeeper:project:${p.aname}`, p_title: p.aname, p_category: inferCategory(p.aname),
      })
      if (error) errors.push(`Project "${p.aname}": ${error.message}`)
      else imported++
    }
    return NextResponse.json({ imported, errors })
  }

  if (body.phase === 'donations') {
    // Project id lookups are cheap and always correct even across separate
    // batch requests — the projects phase already ran and logged them.
    const anames = [...new Set(body.items.map((d) => d.projectAname).filter((a): a is string => !!a))]
    const { data: projRows } = await supabase.from('legacy_import_records').select('external_ref, entity_id')
      .eq('entity_type', 'project').in('external_ref', anames.map((a) => `bookkeeper:project:${a}`))
    const projectIds = Object.fromEntries((projRows ?? []).map((r) => [r.external_ref.replace('bookkeeper:project:', ''), r.entity_id]))

    for (const d of body.items) {
      const projectId = d.projectAname ? projectIds[d.projectAname] ?? null : null
      const notes = `Imported from BookKeeper (${d.vchNo})${d.narration ? ': ' + d.narration : ''}`
      const { error } = await supabase.rpc('import_legacy_donation', {
        p_external_ref: `bookkeeper:receipt:${d.vchNo}`, p_name: d.donorName, p_phone: d.donorPhone,
        p_donor_type: d.donorType, p_amount: d.amount, p_date: d.date, p_project_id: projectId, p_notes: notes,
      })
      if (error) errors.push(`Donation ${d.vchNo} (${d.donorName}): ${error.message}`)
      else imported++
    }
    return NextResponse.json({ imported, errors })
  }

  if (body.phase === 'expenses') {
    const anames = [...new Set(body.items.map((e) => e.projectAname))]
    const { data: projRows } = await supabase.from('legacy_import_records').select('external_ref, entity_id')
      .eq('entity_type', 'project').in('external_ref', anames.map((a) => `bookkeeper:project:${a}`))
    const projectIds = Object.fromEntries((projRows ?? []).map((r) => [r.external_ref.replace('bookkeeper:project:', ''), r.entity_id]))

    for (const e of body.items) {
      const projectId = projectIds[e.projectAname]
      if (!projectId) { errors.push(`Expense ${e.externalRef}: project "${e.projectAname}" not found — run the Projects phase first`); continue }
      // e.externalRef is the plain vchNo for a simple voucher, or
      // "<vchNo>-<n>" for one real line of a compound BookKeeper voucher
      // that got split across several categories — receipt_no always
      // stays the plain original number so statements show the real
      // BookKeeper voucher number, not the synthetic per-line suffix.
      const particular = `${e.category}${e.narration ? ' — ' + e.narration : ''} (BookKeeper ${e.vchNo})`
      const { error } = await supabase.rpc('import_legacy_expense', {
        p_external_ref: `bookkeeper:payment:${e.externalRef}`, p_expense_account_name: e.category,
        p_project_id: projectId, p_amount: e.amount, p_date: e.date, p_particular: particular, p_receipt_no: e.vchNo,
      })
      if (error) errors.push(`Expense ${e.externalRef}: ${error.message}`)
      else imported++
    }
    return NextResponse.json({ imported, errors })
  }

  // expenseReversals — a BookKeeper Receipt that refunded money back into an
  // expense account (e.g. a hospital returning an unused advance), never a
  // donation.
  const anames = [...new Set(body.items.map((r) => r.projectAname).filter((a): a is string => !!a))]
  const { data: projRows } = await supabase.from('legacy_import_records').select('external_ref, entity_id')
    .eq('entity_type', 'project').in('external_ref', anames.map((a) => `bookkeeper:project:${a}`))
  const projectIds = Object.fromEntries((projRows ?? []).map((r) => [r.external_ref.replace('bookkeeper:project:', ''), r.entity_id]))

  for (const r of body.items) {
    const projectId = r.projectAname ? projectIds[r.projectAname] ?? null : null
    const particular = `Refund into ${r.expenseAccountName}${r.narration ? ' — ' + r.narration : ''} (BookKeeper ${r.vchNo})`
    const { error } = await supabase.rpc('import_legacy_expense_reversal', {
      p_external_ref: `bookkeeper:receipt:${r.vchNo}`, p_expense_account_name: r.expenseAccountName,
      p_project_id: projectId, p_amount: r.amount, p_date: r.date, p_particular: particular, p_receipt_no: r.vchNo,
    })
    if (error) errors.push(`Reversal ${r.vchNo}: ${error.message}`)
    else imported++
  }
  return NextResponse.json({ imported, errors })
}
