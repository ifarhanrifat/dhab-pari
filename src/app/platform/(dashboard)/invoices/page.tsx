'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Receipt, CheckCircle2, PlayCircle, X } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Invoice {
  id: string
  invoice_number: string
  tenant_id: string
  period_start: string
  period_end: string
  subscription_amount_pkr: number
  commission_amount_pkr: number
  total_amount_pkr: number
  status: string
  issued_at: string
  paid_at: string | null
  tenants: { name: string } | null
}

const statusColors: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  void: 'bg-gray-100 text-gray-600',
}

function firstOfMonth(offset = 0) {
  const d = new Date()
  d.setMonth(d.getMonth() + offset, 1)
  return d.toISOString().slice(0, 10)
}
function lastOfMonth(offset = 0) {
  const d = new Date()
  d.setMonth(d.getMonth() + offset + 1, 0)
  return d.toISOString().slice(0, 10)
}

export default function PlatformInvoicesPage() {
  const supabase = createClient()
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [showGenerate, setShowGenerate] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [period, setPeriod] = useState({ period_start: firstOfMonth(-1), period_end: lastOfMonth(-1) })

  const load = async () => {
    const { data, error } = await supabase
      .from('platform_invoices')
      .select('*, tenants(name)')
      .order('issued_at', { ascending: false })
    if (error) { toast.error(friendlyError(error)); return }
    setInvoices((data as unknown as Invoice[]) ?? [])
  }

  useEffect(() => { load() }, [])

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    setGenerating(true)
    const { data, error } = await supabase.rpc('platform_generate_monthly_invoices', {
      p_period_start: period.period_start,
      p_period_end: period.period_end,
    })
    setGenerating(false)
    if (error) { toast.error(friendlyError(error)); return }
    const count = (data as { invoices_created?: number } | null)?.invoices_created ?? 0
    toast.success(count > 0 ? `${count} invoice(s) generated.` : 'Nothing to generate — every subscribed tenant already has an invoice for this period.')
    setShowGenerate(false)
    load()
  }

  const markPaid = async (invoice: Invoice) => {
    const { error } = await supabase.rpc('platform_mark_invoice_paid', { p_invoice_id: invoice.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Marked as paid.')
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Invoices</h1>
          <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">
            Subscription fee + commission, billed to each subscribed tenant per period.
          </p>
        </div>
        <button
          onClick={() => setShowGenerate(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-[#1a1f2e] text-white rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 cursor-pointer"
        >
          <PlayCircle size={16} /> Generate Invoices
        </button>
      </div>

      {invoices === null ? (
        <div className="flex justify-center py-16"><LoadingDots /></div>
      ) : invoices.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <Receipt size={28} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-dp-on-surface-variant">No invoices yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container text-dp-on-surface-variant text-left">
              <tr>
                <th className="px-4 py-3 font-semibold">Invoice</th>
                <th className="px-4 py-3 font-semibold">Tenant</th>
                <th className="px-4 py-3 font-semibold">Period</th>
                <th className="px-4 py-3 font-semibold">Subscription</th>
                <th className="px-4 py-3 font-semibold">Commission</th>
                <th className="px-4 py-3 font-semibold">Total</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-t border-dp-outline-variant">
                  <td className="px-4 py-3 font-semibold">{inv.invoice_number}</td>
                  <td className="px-4 py-3">{inv.tenants?.name ?? '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{inv.period_start} – {inv.period_end}</td>
                  <td className="px-4 py-3 tabular-nums">Rs {Number(inv.subscription_amount_pkr).toLocaleString()}</td>
                  <td className="px-4 py-3 tabular-nums">Rs {Number(inv.commission_amount_pkr).toLocaleString()}</td>
                  <td className="px-4 py-3 tabular-nums font-semibold">Rs {Number(inv.total_amount_pkr).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${statusColors[inv.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(inv.status === 'pending' || inv.status === 'overdue') && (
                      <button
                        onClick={() => markPaid(inv)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 hover:bg-green-100 rounded-lg text-[12.5px] font-semibold cursor-pointer transition-all"
                      >
                        <CheckCircle2 size={13} /> Mark Paid
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showGenerate && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowGenerate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-sans text-[18px] font-bold text-dp-on-surface">Generate Invoices</h2>
              <button onClick={() => setShowGenerate(false)} className="text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              Creates one invoice per subscribed tenant for this period. Re-running for a period that already has an invoice skips it — safe to repeat.
            </p>
            <form onSubmit={handleGenerate} className="space-y-4">
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Period Start</label>
                <input
                  type="date" value={period.period_start}
                  onChange={(e) => setPeriod((p) => ({ ...p, period_start: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <div>
                <label className="block text-[13px] font-semibold text-dp-on-surface-variant mb-1.5 font-sans">Period End</label>
                <input
                  type="date" value={period.period_end}
                  onChange={(e) => setPeriod((p) => ({ ...p, period_end: e.target.value }))}
                  required
                  className="w-full px-3 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[14px] focus:border-dp-secondary focus:ring-0"
                />
              </div>
              <button
                type="submit" disabled={generating}
                className="w-full bg-[#1a1f2e] text-white py-2.5 rounded-lg font-sans font-semibold text-[14px] hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
