import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getJazzCashConfig, verifyReturnedFields } from '@/lib/payments/jazzcash'

// JazzCash's own redirect back from the Hosted Checkout Page (pp_ReturnURL
// above) — no admin session exists here at all, so this bypasses the
// gated platform_mark_invoice_paid RPC entirely and writes directly via
// the service-role client. The verified pp_SecureHash (recomputed
// server-side with the integrity salt JazzCash never sees) is the real
// authorization boundary here, equivalent in spirit to is_platform_admin()
// for every other platform_* mutation.
//
// Idempotent: a replayed or duplicate callback on an already-paid invoice
// is a silent no-op, never a user-facing error.
async function handleReturn(fields: Record<string, string>) {
  const config = getJazzCashConfig()
  if (!config) {
    return NextResponse.redirect('https://' + (process.env.NEXT_PUBLIC_DOMAIN?.trim() || 'dhabpari.com') + '/admin/subscription?payment=error')
  }

  const origin = `https://${process.env.NEXT_PUBLIC_DOMAIN?.trim() || 'dhabpari.com'}`
  const redirectTo = (status: 'success' | 'failed' | 'error') => NextResponse.redirect(`${origin}/admin/subscription?payment=${status}`)

  if (!verifyReturnedFields(fields, config.integritySalt)) {
    console.error('jazzcash webhook: secure hash verification failed', fields.pp_TxnRefNo)
    return redirectTo('error')
  }

  const txnRefNo = fields.pp_TxnRefNo
  const responseCode = fields.pp_ResponseCode
  if (!txnRefNo) return redirectTo('error')

  const admin = createAdminClient()
  const { data: invoice } = await admin.from('platform_invoices')
    .select('id, status, tenant_id')
    .eq('invoice_number', txnRefNo)
    .maybeSingle()
  if (!invoice) {
    console.error('jazzcash webhook: no invoice for txnRefNo', txnRefNo)
    return redirectTo('error')
  }

  // Already settled — most likely a duplicate callback. Treat as success
  // either way rather than erroring on something already resolved.
  if (invoice.status === 'paid') return redirectTo('success')

  // '000' is JazzCash's documented success code for this API.
  if (responseCode !== '000') {
    return redirectTo('failed')
  }

  await admin.from('platform_invoices').update({
    status: 'paid',
    paid_at: new Date().toISOString(),
    gateway_provider: 'jazzcash',
    gateway_reference: fields.pp_RetreivalReferenceNo || fields.pp_TxnRefNo,
  }).eq('id', invoice.id)

  await admin.from('platform_audit_log').insert({
    actor_platform_admin_id: null,
    actor_name: 'JazzCash (automated)',
    action: 'invoice_marked_paid',
    target_tenant_id: invoice.tenant_id,
    details: { invoice_id: invoice.id, gateway: 'jazzcash', reference: fields.pp_RetreivalReferenceNo || null },
  })

  return redirectTo('success')
}

export async function POST(req: NextRequest) {
  const form = await req.formData()
  const fields: Record<string, string> = {}
  form.forEach((value, key) => { fields[key] = String(value) })
  return handleReturn(fields)
}

export async function GET(req: NextRequest) {
  const fields: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => { fields[key] = value })
  return handleReturn(fields)
}
