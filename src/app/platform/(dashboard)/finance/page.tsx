'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Landmark, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface TenantFinance {
  tenant_id: string
  tenant_name: string
  plan_name: string | null
  subscription_status: string | null
  marketplace_income_pkr: number
  marketplace_commission_pkr: number
  outstanding_invoices_pkr: number
  ilan_requests_pending: number
}

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  trialing: 'bg-blue-100 text-blue-800',
  past_due: 'bg-amber-100 text-amber-800',
}

export default function PlatformFinancePage() {
  const supabase = createClient()
  const [rows, setRows] = useState<TenantFinance[] | null>(null)

  useEffect(() => {
    supabase.rpc('platform_tenant_finance_summary').then(({ data, error }) => {
      if (error) { toast.error(friendlyError(error)); setRows([]); return }
      setRows((data as TenantFinance[]) ?? [])
    })
  }, [supabase])

  if (rows === null) return <div className="flex justify-center py-16"><LoadingDots /></div>

  const totalMarketplaceIncome = rows.reduce((s, r) => s + Number(r.marketplace_income_pkr), 0)
  const totalOutstanding = rows.reduce((s, r) => s + Number(r.outstanding_invoices_pkr), 0)

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Finance &amp; Settlements</h1>
        <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">
          Every village's own marketplace earnings and what it currently owes the platform, in one place. Marketplace income stays the committee's own money — this is a report, not a ledger you post against.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-1">Total marketplace income (all villages)</p>
          <p className="font-sans text-[24px] font-bold text-dp-on-surface">₨{fmt(totalMarketplaceIncome)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5">
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-1">Total outstanding on platform invoices</p>
          <p className={`font-sans text-[24px] font-bold ${totalOutstanding > 0 ? 'text-dp-error' : 'text-dp-on-surface'}`}>₨{fmt(totalOutstanding)}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <Landmark size={28} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-dp-on-surface-variant">No tenants yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container-low text-dp-on-surface-variant text-[12px] uppercase tracking-[0.04em]">
              <tr>
                <th className="text-start p-3">Village</th>
                <th className="text-start p-3">Plan</th>
                <th className="text-end p-3">Marketplace income</th>
                <th className="text-end p-3">Committee commission</th>
                <th className="text-end p-3">Owed to platform</th>
                <th className="text-end p-3">Ilans pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tenant_id} className="border-t border-dp-outline-variant">
                  <td className="p-3 font-semibold text-dp-on-surface">{r.tenant_name}</td>
                  <td className="p-3">
                    {r.plan_name ? (
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${statusColors[r.subscription_status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}>
                        {r.plan_name}
                      </span>
                    ) : (
                      <span className="text-dp-on-surface-variant">No active plan</span>
                    )}
                  </td>
                  <td className="p-3 text-end tabular-nums">₨{fmt(r.marketplace_income_pkr)}</td>
                  <td className="p-3 text-end tabular-nums">₨{fmt(r.marketplace_commission_pkr)}</td>
                  <td className="p-3 text-end tabular-nums">
                    {r.outstanding_invoices_pkr > 0 ? (
                      <span className="inline-flex items-center gap-1 text-dp-error font-bold"><AlertTriangle size={12} /> ₨{fmt(r.outstanding_invoices_pkr)}</span>
                    ) : (
                      <span className="text-dp-on-surface-variant">₨0</span>
                    )}
                  </td>
                  <td className="p-3 text-end tabular-nums">{r.ilan_requests_pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
