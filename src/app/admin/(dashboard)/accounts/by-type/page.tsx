'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Eye, Power } from 'lucide-react'
import { toast } from 'sonner'

interface Account {
  id: string; code: string; name: string; name_ur: string | null
  type: string; system: string; opening_balance: number; is_active: boolean; is_protected: boolean
}

const systemLabels: Record<string, string> = { water_supply: 'Water Supply System', donors_projects: 'Donors & Projects System' }
const creditNormal = (type: string) => type === 'donor' || type === 'income' || type === 'liability'

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function AccountsByTypePage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>}>
      <AccountsByTypePageInner />
    </Suspense>
  )
}

function AccountsByTypePageInner() {
  const searchParams = useSearchParams()
  const system = searchParams.get('system') ?? 'water_supply'
  const type = searchParams.get('type') ?? 'cash'

  const [accounts, setAccounts] = useState<Account[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [headerLabel, setHeaderLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: accts }, { data: ledger }, { data: header }] = await Promise.all([
      supabase.from('accounts').select('id, code, name, name_ur, type, system, opening_balance, is_active, is_protected')
        .eq('system', system).eq('type', type).order('code'),
      supabase.from('ledger_entries').select('account_id, debit, credit'),
      supabase.from('account_headers').select('label').eq('system', system).eq('code', type).single(),
    ])
    setAccounts(accts ?? [])
    setHeaderLabel(header?.label ?? type)
    const bMap: Record<string, number> = {}
    ;(ledger ?? []).forEach((l: { account_id: string; debit: number; credit: number }) => {
      bMap[l.account_id] = (bMap[l.account_id] ?? 0) + Number(l.debit) - Number(l.credit)
    })
    setBalances(bMap)
    setLoading(false)
  }, [system, type, supabase])

  useEffect(() => { load() }, [load])

  const balanceOf = (a: Account) => {
    const net = balances[a.id] ?? 0
    return creditNormal(a.type) ? Number(a.opening_balance) - net : Number(a.opening_balance) + net
  }

  const toggleActive = async (a: Account) => {
    const { error } = await supabase.from('accounts').update({ is_active: !a.is_active }).eq('id', a.id)
    if (error) { toast.error(error.message); return }
    toast.success(a.is_active ? 'Account deactivated' : 'Account activated')
    load()
  }

  const total = accounts.reduce((s, a) => s + balanceOf(a), 0)

  return (
    <>
      <div className="mb-6">
        <Link href="/admin" className="flex items-center gap-2 text-dp-on-surface-variant hover:text-dp-primary font-sans text-[14px] font-semibold mb-3">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary">{headerLabel}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{systemLabels[system] ?? system}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[650px]">
            <thead>
              <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                <th className="px-4 py-2.5">Code</th>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5 text-right">Balance</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">Loading...</td></tr>}
              {!loading && accounts.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">No accounts under this header yet.</td></tr>}
              {!loading && accounts.map((a) => (
                <tr key={a.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${!a.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant whitespace-nowrap">{a.code}</td>
                  <td className="px-4 py-3 font-semibold text-dp-on-surface">{a.name}</td>
                  <td className="px-4 py-3 text-right font-bold">{fmtAmount(balanceOf(a))}</td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${a.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {a.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <Link href={`/admin/accounts/${a.id}`} title="View" className="p-1.5 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"><Eye size={15} /></Link>
                      <button onClick={() => toggleActive(a)} title={a.is_active ? 'Deactivate' : 'Activate'} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Power size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            {!loading && accounts.length > 0 && (
              <tfoot>
                <tr className="font-sans text-[14px] font-bold bg-dp-surface-container-low/60 border-t-2 border-dp-outline-variant">
                  <td className="px-4 py-3" colSpan={2}>Total</td>
                  <td className="px-4 py-3 text-right">{fmtAmount(total)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  )
}
