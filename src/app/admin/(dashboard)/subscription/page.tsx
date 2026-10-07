'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { CreditCard, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Invoice {
  id: string; invoice_number: string; period_start: string; period_end: string
  subscription_amount_pkr: number; commission_amount_pkr: number; total_amount_pkr: number
  status: string; issued_at: string; paid_at: string | null
}

interface Subscription {
  status: string; current_period_end: string; billing_cycle: string
  plan: { name: string; monthly_price_pkr: number } | null
}

const statusColors: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  void: 'bg-gray-100 text-gray-600',
}

function SubscriptionPageInner() {
  const supabase = createClient()
  const searchParams = useSearchParams()
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [payingId, setPayingId] = useState<string | null>(null)

  const load = async () => {
    const [{ data: subs }, { data: invs }] = await Promise.all([
      supabase.from('tenant_subscriptions')
        .select('status, current_period_end, billing_cycle, plan:subscription_plans(name, monthly_price_pkr)')
        .in('status', ['active', 'trialing', 'past_due'])
        .maybeSingle(),
      supabase.from('platform_invoices').select('*').order('issued_at', { ascending: false }),
    ])
    setSubscription(subs as unknown as Subscription | null)
    setInvoices((invs as Invoice[]) ?? [])
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const payment = searchParams.get('payment')
    if (payment === 'success') toast.success('Payment received — thank you!')
    else if (payment === 'failed') toast.error('Payment was not completed. You can try again.')
    else if (payment === 'error') toast.error('Something went wrong verifying that payment. Contact the platform operator if this keeps happening.')
  }, [searchParams])

  const payInvoice = async (invoice: Invoice) => {
    setPayingId(invoice.id)
    try {
      const res = await fetch(`/api/platform/invoices/${invoice.id}/checkout`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Could not start the payment.')
        return
      }
      // JazzCash's Hosted Checkout expects a real browser form POST, not a
      // fetch redirect — build and auto-submit one.
      const form = document.createElement('form')
      form.method = 'POST'
      form.action = data.actionUrl
      for (const [key, value] of Object.entries(data.fields as Record<string, string>)) {
        const input = document.createElement('input')
        input.type = 'hidden'
        input.name = key
        input.value = value
        form.appendChild(input)
      }
      document.body.appendChild(form)
      form.submit()
    } catch (err) {
      toast.error(friendlyError(err))
    } finally {
      setPayingId(null)
    }
  }

  if (invoices === null) {
    return <div className="flex justify-center py-16"><LoadingDots /></div>
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Subscription & Billing</h1>
        <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">Your committee's platform plan and invoices.</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-6">
        <h2 className="font-sans text-[15px] font-bold text-dp-on-surface flex items-center gap-2 mb-3">
          <CreditCard size={16} /> Current Plan
        </h2>
        {subscription ? (
          <div className="flex items-center gap-3">
            <p className="font-sans text-[14px] text-dp-on-surface">
              {subscription.plan?.name ?? '—'} — Rs {Number(subscription.plan?.monthly_price_pkr ?? 0).toLocaleString()}/mo
            </p>
            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
              subscription.status === 'active' ? 'bg-green-100 text-green-800'
                : subscription.status === 'trialing' ? 'bg-blue-100 text-blue-800'
                : 'bg-amber-100 text-amber-800'
            }`}>
              {subscription.status}
            </span>
            {subscription.status === 'past_due' && (
              <span className="inline-flex items-center gap-1 text-red-700 text-[12.5px] font-sans">
                <AlertTriangle size={13} /> Payment overdue — see invoices below
              </span>
            )}
          </div>
        ) : (
          <p className="font-sans text-[14px] text-dp-on-surface-variant">No active subscription on file.</p>
        )}
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden overflow-x-auto">
        <div className="p-5 border-b border-dp-outline-variant">
          <h2 className="font-sans text-[15px] font-bold text-dp-on-surface">Invoices</h2>
        </div>
        {invoices.length === 0 ? (
          <p className="p-5 text-dp-on-surface-variant font-sans text-[14px]">No invoices yet.</p>
        ) : (
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container text-dp-on-surface-variant text-left">
              <tr>
                <th className="px-4 py-3 font-semibold">Invoice</th>
                <th className="px-4 py-3 font-semibold">Period</th>
                <th className="px-4 py-3 font-semibold">Total</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-dp-outline-variant">
                  <td className="px-4 py-3 font-semibold">{inv.invoice_number}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{inv.period_start} – {inv.period_end}</td>
                  <td className="px-4 py-3 tabular-nums font-semibold">Rs {Number(inv.total_amount_pkr).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${statusColors[inv.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(inv.status === 'pending' || inv.status === 'overdue') && (
                      <button
                        onClick={() => payInvoice(inv)}
                        disabled={payingId === inv.id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white hover:opacity-90 rounded-lg text-[12.5px] font-semibold cursor-pointer transition-all disabled:opacity-50"
                      >
                        <CheckCircle2 size={13} /> {payingId === inv.id ? 'Starting...' : 'Pay via JazzCash'}
                      </button>
                    )}
                    {inv.status === 'paid' && (
                      <span className="inline-flex items-center gap-1 text-green-700 text-[12.5px] font-sans">
                        <CheckCircle2 size={13} /> Paid
                      </span>
                    )}
                    {inv.status === 'void' && (
                      <span className="inline-flex items-center gap-1 text-dp-on-surface-variant text-[12.5px] font-sans">
                        <XCircle size={13} /> Void
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default function SubscriptionPage() {
  return (
    <Suspense fallback={null}>
      <SubscriptionPageInner />
    </Suspense>
  )
}
