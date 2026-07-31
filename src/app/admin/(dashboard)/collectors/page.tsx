'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Coins, HandCoins, History } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { useSystemAccess } from '@/hooks/useSystemAccess'

interface FieldCollector { id: string; full_name: string; mobile: string | null; assigned_sectors: string[] | null }
interface Account { id: string; name: string; type: string; collector_id: string | null; opening_balance: number }
interface LedgerAgg { account_id: string; debit: number; credit: number }
interface Settlement { id: string; collector_id: string; amount_pkr: number; method: string; settled_date: string; note: string | null; to_account_id: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function CollectorsPage() {
  const access = useSystemAccess()
  const supabase = createClient()
  const [collectors, setCollectors] = useState<FieldCollector[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [ledger, setLedger] = useState<LedgerAgg[]>([])
  const [cashBankAccounts, setCashBankAccounts] = useState<{ id: string; name: string }[]>([])
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [loading, setLoading] = useState(true)
  const [canSettle, setCanSettle] = useState(false)

  const [settleFor, setSettleFor] = useState<{ collectorId: string; name: string; balance: number } | null>(null)
  const [settleAmount, setSettleAmount] = useState(0)
  const [settleToAccount, setSettleToAccount] = useState('')
  const [settleMethod, setSettleMethod] = useState('cash')
  const [settleNote, setSettleNote] = useState('')
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: me } = await supabase.from('admin_users').select('role, can_post_transactions').eq('auth_user_id', user.id).single()
      setCanSettle(!!me && me.role !== 'viewer' && (me.role === 'super_admin' || me.can_post_transactions))
    }
    const [{ data: collectorsData }, { data: accountsData }, { data: ledgerData }, { data: settlementsData }] = await Promise.all([
      supabase.rpc('get_field_collectors'),
      supabase.from('accounts').select('id, name, type, collector_id, opening_balance').eq('system', 'water_supply').in('type', ['collector', 'cash', 'bank']),
      supabase.from('ledger_entries').select('account_id, debit, credit'),
      supabase.from('collector_settlements').select('*').order('settled_date', { ascending: false }).limit(50),
    ])
    setCollectors(collectorsData ?? [])
    setAccounts((accountsData ?? []).filter((a) => a.type === 'collector'))
    setCashBankAccounts((accountsData ?? []).filter((a) => a.type === 'cash' || a.type === 'bank').map((a) => ({ id: a.id, name: a.name })))
    setLedger(ledgerData ?? [])
    setSettlements(settlementsData ?? [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const balanceByAccount = useMemo(() => {
    const map: Record<string, number> = {}
    ledger.forEach((l) => { map[l.account_id] = (map[l.account_id] ?? 0) + Number(l.debit) - Number(l.credit) })
    return map
  }, [ledger])

  const rows = useMemo(() => {
    return collectors.map((c) => {
      const acct = accounts.find((a) => a.collector_id === c.id)
      const balance = acct ? Number(acct.opening_balance) + (balanceByAccount[acct.id] ?? 0) : 0
      return { collector: c, accountId: acct?.id ?? null, balance }
    }).sort((a, b) => b.balance - a.balance)
  }, [collectors, accounts, balanceByAccount])

  const totalHeld = rows.reduce((s, r) => s + Math.max(r.balance, 0), 0)

  const openSettle = (r: { collector: FieldCollector; balance: number }) => {
    setSettleFor({ collectorId: r.collector.id, name: r.collector.full_name, balance: r.balance })
    setSettleAmount(Math.max(r.balance, 0))
    setSettleToAccount('')
    setSettleMethod('cash')
    setSettleNote('')
  }

  const saveSettlement = async () => {
    if (!settleFor || settleAmount <= 0 || !settleToAccount) { toast.error('Enter an amount and destination account'); return }
    setSaving(true)
    const { error } = await supabase.from('collector_settlements').insert({
      collector_id: settleFor.collectorId, amount_pkr: settleAmount,
      to_account_id: settleToAccount, method: settleMethod, note: settleNote || null,
    })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Rs. ${fmt(settleAmount)} received from ${settleFor.name}`)
    setSettleFor(null)
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">Loading...</div>
  if (!access.canWaterSupply) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Collectors belongs to the Water Supply system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  return (
    <>
      <Toaster position="top-right" />
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Coins size={26} /> Field Collectors
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">Cash collected on the spot by field collectors, pending remittance.</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3 mb-5 inline-block">
        <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">Total Held by Collectors</p>
        <p className="font-heading text-[20px] font-bold text-dp-primary">Rs. {fmt(totalHeld)}</p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden mb-6">
        <div className="px-5 py-3.5 border-b border-dp-outline-variant bg-dp-surface-container-low/60 flex items-center gap-2">
          <HandCoins size={16} className="text-dp-secondary" />
          <span className="font-sans text-[14px] font-bold text-dp-on-surface">Current Holdings</span>
        </div>
        {loading ? (
          <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">No field collectors set up yet — grant collector access from User Management.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[550px]">
              <thead>
                <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                  <th className="px-5 py-2.5">Collector</th>
                  <th className="px-5 py-2.5">Sectors</th>
                  <th className="px-5 py-2.5 text-right">Holding</th>
                  <th className="px-5 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.collector.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                    <td className="px-5 py-3 font-semibold">{r.collector.full_name}</td>
                    <td className="px-5 py-3 text-dp-on-surface-variant">{(r.collector.assigned_sectors ?? []).join(', ') || '—'}</td>
                    <td className={`px-5 py-3 text-right font-bold ${r.balance > 0 ? 'text-dp-error' : 'text-dp-on-surface-variant'}`}>Rs. {fmt(r.balance)}</td>
                    <td className="px-5 py-3 text-right">
                      {canSettle && r.balance > 0 && (
                        <button onClick={() => openSettle(r)} className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                          Settle
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="px-5 py-3.5 border-b border-dp-outline-variant bg-dp-surface-container-low/60 flex items-center gap-2">
          <History size={16} className="text-dp-secondary" />
          <span className="font-sans text-[14px] font-bold text-dp-on-surface">Settlement History</span>
        </div>
        {settlements.length === 0 ? (
          <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">No settlements recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[500px]">
              <thead>
                <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                  <th className="px-5 py-2.5">Date</th>
                  <th className="px-5 py-2.5">Collector</th>
                  <th className="px-5 py-2.5">Method</th>
                  <th className="px-5 py-2.5 text-right">Amount</th>
                  <th className="px-5 py-2.5">Note</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                    <td className="px-5 py-3 whitespace-nowrap">{new Date(s.settled_date).toLocaleDateString('en-GB')}</td>
                    <td className="px-5 py-3 font-semibold">{collectors.find((c) => c.id === s.collector_id)?.full_name ?? '—'}</td>
                    <td className="px-5 py-3 capitalize text-dp-on-surface-variant">{s.method}</td>
                    <td className="px-5 py-3 text-right font-bold">Rs. {fmt(s.amount_pkr)}</td>
                    <td className="px-5 py-3 text-dp-on-surface-variant">{s.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {settleFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setSettleFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[20px] font-bold text-dp-primary mb-1">Settle with {settleFor.name}</h2>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">Currently holding Rs. {fmt(settleFor.balance)}</p>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Amount Received (PKR)</label>
                <input type="number" min={1} value={settleAmount || ''} onChange={(e) => setSettleAmount(+e.target.value)} className="input-field" />
              </div>
              <SearchableField
                label="Deposit Into"
                value={settleToAccount}
                onChange={setSettleToAccount}
                placeholder="Select cash/bank account..."
                items={cashBankAccounts.map((a) => ({ id: a.id, label: a.name }))}
              />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Method</label>
                <select value={settleMethod} onChange={(e) => setSettleMethod(e.target.value)} className="input-field">
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Note (optional)</label>
                <input value={settleNote} onChange={(e) => setSettleNote(e.target.value)} className="input-field" />
              </div>
              <button disabled={saving} onClick={saveSettlement} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {saving ? 'Saving...' : 'Confirm Received'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
