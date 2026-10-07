import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getJazzCashConfig, jazzCashCheckoutUrl, buildCheckoutFields as buildJazzCashFields } from '@/lib/payments/jazzcash'
import { getEasyPaisaConfig, easyPaisaCheckoutUrl, buildCheckoutFields as buildEasyPaisaFields } from '@/lib/payments/easypaisa'

// Initiates a checkout redirect (JazzCash or EasyPaisa) for one of the
// caller's own tenant's invoices (or any invoice, for a platform admin)
// — gated by the existing platform_invoices_own_read RLS policy
// (tenant_id = my_tenant_id() or is_platform_admin()), so the SELECT
// below already returns nothing for an invoice that doesn't belong to
// the caller.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: invoiceId } = await params
  let body: { provider?: string }
  try {
    body = await req.json()
  } catch {
    body = {}
  }
  const provider = body.provider === 'easypaisa' ? 'easypaisa' : 'jazzcash'

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: invoice, error } = await supabase.from('platform_invoices')
    .select('id, invoice_number, total_amount_pkr, status')
    .eq('id', invoiceId)
    .maybeSingle()
  if (error || !invoice) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 })
  if (invoice.status !== 'pending' && invoice.status !== 'overdue') {
    return NextResponse.json({ error: 'This invoice is already settled.' }, { status: 409 })
  }

  const origin = req.nextUrl.origin
  const notConfigured = (name: string) => NextResponse.json({
    error: `${name} is not configured yet for this platform. Contact the platform operator, or pay by bank transfer and ask them to mark this invoice paid manually.`,
  }, { status: 503 })

  if (provider === 'easypaisa') {
    const config = getEasyPaisaConfig()
    if (!config) return notConfigured('EasyPaisa')
    const fields = buildEasyPaisaFields(config, {
      amountPkr: invoice.total_amount_pkr,
      txnRefNo: invoice.invoice_number,
      description: `Platform subscription — ${invoice.invoice_number}`,
      returnUrl: `${origin}/api/webhooks/easypaisa`,
    })
    return NextResponse.json({ actionUrl: easyPaisaCheckoutUrl(config.mode), fields })
  }

  const config = getJazzCashConfig()
  if (!config) return notConfigured('JazzCash')
  const fields = buildJazzCashFields(config, {
    amountPkr: invoice.total_amount_pkr,
    txnRefNo: invoice.invoice_number,
    description: `Platform subscription — ${invoice.invoice_number}`,
    returnUrl: `${origin}/api/webhooks/jazzcash`,
  })
  return NextResponse.json({ actionUrl: jazzCashCheckoutUrl(config.mode), fields })
}
