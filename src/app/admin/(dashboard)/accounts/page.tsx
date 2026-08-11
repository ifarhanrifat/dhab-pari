'use client'

import { useEffect, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Save, Droplets, Heart, Search, MoreVertical, ChevronDown, ChevronUp, SlidersHorizontal, Eye, Power } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Account {
  id: string
  code: string
  name: string
  name_ur: string | null
  type: string
  system: string
  description: string | null
  opening_balance: number
  is_active: boolean
  consumer_id: string | null
  donor_key: string | null
  parent_account_id: string | null
}

interface AccountHeader {
  id: string
  system: string
  code: string
  label: string
  label_ur: string | null
  code_prefix: string
  display_order: number
  is_system: boolean
}

interface ConsumerInfo {
  consumer_id: string
  mobile: string
  address: string | null
  connections: number
  monthly_rate: number
  status: string
}

type SystemTab = 'water_supply' | 'donors_projects'
type Lang = 'en' | 'ur'

const emptyAccount = {
  name: '',
  name_ur: '',
  headerId: '',
  system: 'water_supply' as SystemTab,
  description: '',
  opening_balance: 0,
  is_active: true,
}

const emptyHeaderForm = { label: '', label_ur: '', code: '', code_prefix: '' }

function fmtAmount(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function AccountsPage() {
  const { t, locale } = useLocale()
  const router = useRouter()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [headers, setHeaders] = useState<AccountHeader[]>([])
  const [consumers, setConsumers] = useState<Record<string, ConsumerInfo>>({})
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [receiptsByConsumer, setReceiptsByConsumer] = useState<Record<string, string[]>>({})
  // Follows the reader, not the village default: selecting English must
  // actually show English account names.
  const lang: Lang = locale
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<SystemTab>('water_supply')
  const access = useSystemAccess()

  // Don't leave a role-restricted user sitting on a tab whose data RLS will
  // never return — that renders as an empty chart of accounts and reads like
  // a bug rather than a permission boundary. The tab buttons below are hidden
  // for the same reason.
  useEffect(() => {
    if (access.loading) return
    if (tab === 'water_supply' && !access.canWaterSupply) setTab(access.defaultSystem)
    if (tab === 'donors_projects' && !access.canDonorsProjects) setTab(access.defaultSystem)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access.loading, access.canWaterSupply, access.canDonorsProjects, tab])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...emptyAccount, system: 'water_supply' as SystemTab })
  const [showHeaderForm, setShowHeaderForm] = useState(false)
  const [headerForm, setHeaderForm] = useState(emptyHeaderForm)
  const [search, setSearch] = useState('')
  const [sortByBalance, setSortByBalance] = useState(false)
  // Donors/Consumers default closed (that list is long and would otherwise
  // dominate the page) — every other header defaults open, matching how
  // the rest of the Chart of Accounts already behaved.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ consumer: true, donor: true })
  const [menuId, setMenuId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const [accountsRes, headersRes, consumersRes, ledgerRes, paymentsRes] = await Promise.all([
      supabase.from('accounts').select('*').order('code'),
      supabase.from('account_headers').select('*').order('display_order'),
      supabase.from('consumers').select('consumer_id, mobile, address, connections, monthly_rate, status'),
      supabase.from('ledger_entries').select('account_id, debit, credit'),
      supabase.from('payments').select('consumer_id, receipt_no'),
    ])
    setAccounts(accountsRes.data ?? [])
    setHeaders(headersRes.data ?? [])
    const cMap: Record<string, ConsumerInfo> = {}
    ;(consumersRes.data ?? []).forEach((c) => { cMap[c.consumer_id] = c })
    setConsumers(cMap)
    const bMap: Record<string, number> = {}
    ;(ledgerRes.data ?? []).forEach((l: { account_id: string; debit: number; credit: number }) => {
      bMap[l.account_id] = (bMap[l.account_id] ?? 0) + Number(l.debit) - Number(l.credit)
    })
    setBalances(bMap)
    const rMap: Record<string, string[]> = {}
    ;(paymentsRes.data ?? []).forEach((p: { consumer_id: string; receipt_no: string | null }) => {
      if (!p.receipt_no) return
      ;(rMap[p.consumer_id] ??= []).push(p.receipt_no)
    })
    setReceiptsByConsumer(rMap)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const displayName = (name: string, name_ur: string | null) => (lang === 'ur' && name_ur) ? name_ur : name

  // Standard accounting normal-balance rule: cash/bank/asset/expense/consumer accounts
  // increase with a debit; income/liability/donor accounts increase with a credit
  // (income and liabilities are only ever credited in this app so far, but vouchers in
  // Phase 2 start posting real credits to them, so the sign must be correct now).
  const creditNormal = (type: string) => type === 'donor' || type === 'income' || type === 'liability' || type === 'employee' || type === 'project'
  const balanceOf = (a: Account) => creditNormal(a.type)
    ? a.opening_balance - (balances[a.id] ?? 0)
    : a.opening_balance + (balances[a.id] ?? 0)

  const bySystem = useMemo(() => {
    const q = search.trim().toLowerCase()
    return accounts.filter((a) => {
      if (a.system !== tab) return false
      if (!q) return true
      const receipts = a.consumer_id ? receiptsByConsumer[a.consumer_id] ?? [] : []
      return a.name.toLowerCase().includes(q)
        || (a.name_ur ?? '').toLowerCase().includes(q)
        || a.code.toLowerCase().includes(q)
        || receipts.some((r) => r.toLowerCase().includes(q))
    })
  }, [accounts, tab, search, receiptsByConsumer])

  const partyType = tab === 'water_supply' ? 'consumer' : 'donor'
  const partyLabel = tab === 'water_supply' ? 'Consumers' : 'Donors'

  const partyAccounts = useMemo(() => {
    return [...bySystem.filter((a) => a.type === partyType)].sort((a, b) =>
      sortByBalance ? balanceOf(b) - balanceOf(a) : a.name.localeCompare(b.name)
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySystem, partyType, sortByBalance, balances])

  const headersForTab = useMemo(() => {
    return headers
      .filter((h) => h.system === tab && h.code !== partyType)
      .sort((a, b) => a.display_order - b.display_order)
  }, [headers, tab, partyType])

  const byHeader = useMemo(() => {
    const grouped: Record<string, Account[]> = {}
    headersForTab.forEach((h) => { grouped[h.code] = [] })
    bySystem.forEach((a) => {
      if (a.type === partyType) return
      // Accounts with a parent (e.g. every project account, nested under
      // Cash-in-Hand) render under their parent instead of their own
      // header group — see childrenByParent below.
      if (a.parent_account_id) return
      if (!grouped[a.type]) grouped[a.type] = []
      grouped[a.type].push(a)
    })
    Object.keys(grouped).forEach((code) => {
      grouped[code] = [...grouped[code]].sort((a, b) => sortByBalance ? balanceOf(b) - balanceOf(a) : a.name.localeCompare(b.name))
    })
    return grouped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySystem, sortByBalance, balances, headersForTab, partyType])

  // Purely a display grouping (accounts.parent_account_id) — `type` still
  // does all the real work (voucher-picker filters, balance-sign rules), so
  // e.g. a project's memo balance never becomes pickable as real cash/bank
  // just because it's shown nested under Cash-in-Hand here.
  const childrenByParent = useMemo(() => {
    const map: Record<string, Account[]> = {}
    bySystem.forEach((a) => {
      if (a.parent_account_id) (map[a.parent_account_id] ??= []).push(a)
    })
    Object.keys(map).forEach((pid) => {
      map[pid] = [...map[pid]].sort((a, b) => sortByBalance ? balanceOf(b) - balanceOf(a) : a.name.localeCompare(b.name))
    })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bySystem, sortByBalance, balances])

  // Consolidated balance per header — shown in the header bar itself (not
  // just once expanded), so a collapsed section (e.g. Donors/Consumers)
  // still tells you the total at a glance.
  const headerTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    Object.entries(byHeader).forEach(([code, accts]) => {
      totals[code] = accts.reduce((sum, a) => sum + balanceOf(a) + (childrenByParent[a.id] ?? []).reduce((s, c) => s + balanceOf(c), 0), 0)
    })
    return totals
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byHeader, childrenByParent, balances])

  const partyTotal = useMemo(() => partyAccounts.reduce((sum, a) => sum + balanceOf(a), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [partyAccounts, balances])

  const toggleGroup = (code: string) => setCollapsed((prev) => ({ ...prev, [code]: !prev[code] }))

  const openAdd = () => {
    setEditId(null)
    const firstHeader = headers.find((h) => h.system === tab && h.code !== partyType)
    setForm({ ...emptyAccount, system: tab, headerId: firstHeader?.id ?? '' })
    setShowForm(true)
  }

  const openEdit = (a: Account) => {
    setMenuId(null)
    // Consumer accounts are edited from the Billing page now (Edit / Activate /
    // Deactivate / Permanent Disconnection) — this dialog only handles the
    // general chart-of-accounts case.
    const header = headers.find((h) => h.system === a.system && h.code === a.type)
    setEditId(a.id)
    setForm({ name: a.name, name_ur: a.name_ur ?? '', headerId: header?.id ?? '', system: a.system as SystemTab, description: a.description ?? '', opening_balance: a.opening_balance, is_active: a.is_active })
    setShowForm(true)
  }

  const viewAccount = (a: Account) => {
    setMenuId(null)
    router.push(`/admin/accounts/${a.id}`)
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return }
    if (!form.headerId) { toast.error('Choose an account header'); return }
    const header = headers.find((h) => h.id === form.headerId)
    if (!header) { toast.error('Invalid header'); return }

    if (editId) {
      const { error } = await supabase.from('accounts').update({
        name: form.name, name_ur: form.name_ur || null, type: header.code, system: form.system,
        description: form.description || null, opening_balance: form.opening_balance, is_active: form.is_active,
      }).eq('id', editId)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success('Account updated')
    } else {
      const { data: code, error: codeError } = await supabase.rpc('next_account_code', { p_header_id: header.id })
      if (codeError) { toast.error(friendlyError(codeError)); return }
      const { error } = await supabase.from('accounts').insert({
        code, name: form.name, name_ur: form.name_ur || null, type: header.code, system: form.system,
        description: form.description || null, opening_balance: form.opening_balance, is_active: form.is_active,
      })
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(`Account created (${code})`)
    }
    setShowForm(false)
    setEditId(null)
    load()
  }

  const saveHeader = async () => {
    if (!headerForm.label.trim() || !headerForm.code.trim() || !headerForm.code_prefix.trim()) {
      toast.error('Label, code and code prefix are required'); return
    }
    const code = headerForm.code.trim().toLowerCase().replace(/\s+/g, '_')
    const { data, error } = await supabase.from('account_headers').insert({
      system: form.system, code, label: headerForm.label, label_ur: headerForm.label_ur || null,
      code_prefix: headerForm.code_prefix.trim().toUpperCase(), display_order: headers.length + 1,
    }).select().single()
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Header created')
    setShowHeaderForm(false)
    setHeaderForm(emptyHeaderForm)
    await load()
    if (data) setForm((f) => ({ ...f, headerId: data.id }))
  }

  // Consumer active/inactive/disconnected status is managed from the Billing
  // page now — this toggle only ever runs for non-consumer accounts (the menu
  // item is hidden for type='consumer' rows).
  const toggleActive = async (a: Account) => {
    setMenuId(null)
    await supabase.from('accounts').update({ is_active: !a.is_active }).eq('id', a.id)
    toast.success(a.is_active ? 'Account disabled' : 'Account enabled')
    load()
  }

  const waterCount = accounts.filter((a) => a.system === 'water_supply').length
  const donorCount = accounts.filter((a) => a.system === 'donors_projects').length

  const renderRow = (a: Account, indented = false) => {
    const bal = balanceOf(a)
    // One language at a time (Urdu when set and selected, else English) —
    // matches the single-language convention used everywhere else in this
    // app (e.g. /water/apply), rather than always showing both lines, which
    // used to misalign (Urdu line right-aligned, English line under it
    // left-aligned). The Urdu name replaces the English one in the exact
    // same spot/alignment/size — just the correct font-family for legible
    // Urdu glyphs — not re-anchored to the right, so rows don't jump
    // position depending on which account happens to have a translation.
    // The other name is always one click away via Edit.
    const primary = displayName(a.name, a.name_ur)
    const isUrduLine = lang === 'ur' && !!a.name_ur
    return (
      <div
        key={a.id}
        onClick={() => viewAccount(a)}
        className={`flex items-center justify-between gap-3 px-4 py-3.5 border-t border-dp-outline-variant hover:bg-dp-surface-container-low/50 cursor-pointer transition-colors ${!a.is_active ? 'opacity-50' : ''} ${indented ? 'ps-10 bg-dp-surface-container-low/30' : ''}`}
      >
        <div className="min-w-0 flex-1">
          <p className={`font-sans font-semibold text-dp-on-surface truncate ${isUrduLine ? 'text-[13px]' : 'text-[14.5px]'}`} style={isUrduLine ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>
            {indented && <span className="text-dp-on-surface-variant font-normal">↳ </span>}{primary}
          </p>
          {a.type === 'consumer' && a.consumer_id && consumers[a.consumer_id] && (
            <p className="text-[12px] text-dp-on-surface-variant">{consumers[a.consumer_id].mobile}</p>
          )}
        </div>
        {/* Fixed widths, not flex-sized: a header total and the balances under
            it have to sit in the same column, and a chevron is not the same
            width as a menu button. tabular-nums keeps the digits themselves in
            line so the decimal points stack. */}
        <div className="flex items-center gap-2 shrink-0">
          {a.type === 'consumer' && bal < 0 ? (
            <span className="font-sans text-[14.5px] font-bold text-emerald-600 w-36 text-end tabular-nums ltr-num">Advance: {fmtAmount(-bal)}</span>
          ) : (
            <span className={`font-sans text-[14.5px] font-bold w-36 text-end tabular-nums ltr-num ${a.type === 'consumer' && bal > 0 ? 'text-dp-error' : 'text-dp-on-surface'}`}>
              {fmtAmount(bal)}
            </span>
          )}
          <div className="relative w-7 flex justify-center">
            <button
              onClick={(e) => { e.stopPropagation(); setMenuId(menuId === a.id ? null : a.id) }}
              className="p-1 text-dp-on-surface-variant hover:text-dp-primary cursor-pointer"
            >
              <MoreVertical size={18} />
            </button>
            {menuId === a.id && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-7 z-20 w-44 bg-white rounded-lg shadow-lg border border-dp-outline-variant py-1"
              >
                <button onClick={() => viewAccount(a)} className="w-full flex items-center gap-2 px-3 py-2 text-[13.5px] font-sans text-dp-on-surface hover:bg-dp-surface-container-low cursor-pointer">
                  <Eye size={14} /> {t('ac.viewAccount')}
                </button>
                {a.type === 'consumer' ? (
                  <p className="px-3 py-2 text-[12px] font-sans text-dp-on-surface-variant">{t('ac.editFromBilling')}</p>
                ) : (
                  <>
                    <button onClick={() => openEdit(a)} className="w-full flex items-center gap-2 px-3 py-2 text-[13.5px] font-sans text-dp-on-surface hover:bg-dp-surface-container-low cursor-pointer">
                      <Pencil size={14} /> {t('ac.editAccount')}
                    </button>
                    <button onClick={() => toggleActive(a)} className="w-full flex items-center gap-2 px-3 py-2 text-[13.5px] font-sans text-dp-on-surface hover:bg-dp-surface-container-low cursor-pointer">
                      <Power size={14} /> {a.is_active ? 'Disable Account' : 'Enable Account'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('ac.title')}</h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">Manage expense accounts, cash accounts, and income accounts for each system.</p>
      </div>

      <div className="flex gap-2 mb-6">
        {access.canWaterSupply && <button
          onClick={() => setTab('water_supply')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold transition-all cursor-pointer ${tab === 'water_supply' ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
        >
          <Droplets size={16} />
          {t('a.waterSupplySystem')}
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tab === 'water_supply' ? 'bg-white/20 text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{waterCount}</span>
        </button>}
        {access.canDonorsProjects && <button
          onClick={() => setTab('donors_projects')}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg font-sans text-[14px] font-semibold transition-all cursor-pointer ${tab === 'donors_projects' ? 'bg-dp-primary text-white' : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
        >
          <Heart size={16} />
          {t('a.donorsProjects')}
          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tab === 'donors_projects' ? 'bg-white/20 text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{donorCount}</span>
        </button>}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-3 mb-4 flex items-center gap-3">
        <button
          onClick={() => router.push(tab === 'donors_projects' ? '/admin/donors' : '/admin/billing')}
          className="shrink-0 px-4 py-2 rounded-lg bg-dp-surface-container-low text-dp-on-surface font-sans text-[13.5px] font-bold hover:bg-dp-surface-container transition-all cursor-pointer"
        >
          {tab === 'donors_projects' ? 'Donor' : 'Consumer'}
        </button>
        <div className="flex-1 relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by account name, code, or bill/receipt no..."
            className="w-full ps-9 pe-3 py-2 rounded-lg border border-dp-outline-variant text-[13.5px] font-sans focus:outline-none focus:border-dp-primary"
          />
        </div>
        <button
          onClick={() => setSortByBalance((s) => !s)}
          title={sortByBalance ? 'Sorted by balance' : 'Sorted by name'}
          className={`shrink-0 p-2.5 rounded-lg border border-dp-outline-variant cursor-pointer transition-all ${sortByBalance ? 'bg-dp-secondary text-white border-dp-secondary' : 'text-dp-secondary hover:bg-dp-surface-container-low'}`}
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>

      {loading ? (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">{t('ac.loading')}</div>
      ) : (
        <div className="space-y-4 pb-24">
          {partyAccounts.length > 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-dp-surface-container-low/60">
                <button
                  onClick={() => toggleGroup(partyType)}
                  className="flex-1 flex items-center gap-2 cursor-pointer"
                >
                  <span className="font-sans text-[14px] font-bold text-dp-on-surface">{partyLabel}</span>
                  <span className="font-sans text-[13px] font-bold text-dp-secondary ms-auto pe-2">{fmtAmount(partyTotal)}</span>
                  {collapsed[partyType] ? <ChevronDown size={16} className="text-dp-on-surface-variant" /> : <ChevronUp size={16} className="text-dp-on-surface-variant" />}
                </button>
                {partyType === 'consumer' && (
                  <button
                    onClick={() => router.push('/admin/reports?report=consumer_outstanding&system=water_supply')}
                    className="shrink-0 text-[12.5px] font-sans font-semibold text-dp-secondary hover:text-dp-primary cursor-pointer"
                  >
                    {t('ac.viewReceivable')}
                  </button>
                )}
              </div>
              {!collapsed[partyType] && <div>{partyAccounts.map((a) => renderRow(a))}</div>}
            </div>
          )}

          {headersForTab.map((h) => {
            const typeAccounts = byHeader[h.code] ?? []
            if (typeAccounts.length === 0) return null
            const isCollapsed = !!collapsed[h.code]
            return (
              <div key={h.code} className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                <button
                  onClick={() => toggleGroup(h.code)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-dp-surface-container-low/60 hover:bg-dp-surface-container-low cursor-pointer transition-colors"
                >
                  <span className="font-sans text-[14px] font-bold text-dp-on-surface" style={lang === 'ur' && h.label_ur ? { fontFamily: 'var(--font-urdu), serif' } : undefined}>{displayName(h.label, h.label_ur)}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="font-sans text-[14.5px] font-bold text-dp-secondary w-36 text-end tabular-nums ltr-num">{fmtAmount(headerTotals[h.code] ?? 0)}</span>
                    <span className="w-7 flex justify-center">
                      {isCollapsed ? <ChevronDown size={16} className="text-dp-on-surface-variant" /> : <ChevronUp size={16} className="text-dp-on-surface-variant" />}
                    </span>
                  </span>
                </button>
                {!isCollapsed && (
                  <div>
                    {typeAccounts.map((a) => (
                      <div key={a.id}>
                        {renderRow(a)}
                        {(childrenByParent[a.id] ?? []).map((c) => renderRow(c, true))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {bySystem.length === 0 && (
            <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center">
              <p className="font-sans text-[16px] text-dp-on-surface-variant mb-4">{search ? 'No accounts or bills match your search.' : 'No accounts yet for this system.'}</p>
              {!search && (
                <button onClick={openAdd} className="flex items-center gap-2 px-5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer mx-auto">
                  <PlusCircle size={16} /> {t('ac.createFirst')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {menuId && <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />}

      <button
        onClick={openAdd}
        className="fixed bottom-8 right-8 z-30 flex items-center gap-2 px-5 py-3.5 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold shadow-lg hover:bg-dp-primary transition-all cursor-pointer"
      >
        <PlusCircle size={18} /> {t('ac.addNew')}
      </button>

      {/* Add/Edit generic account Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[24px] font-bold text-dp-primary">{editId ? 'Edit Account' : 'New Account'}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              {!editId && (
                <p className="text-[12.5px] font-sans text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2">
                  The account code is generated automatically from the header&apos;s serial number.
                </p>
              )}
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ac.system')}</label>
                <select
                  value={form.system}
                  onChange={(e) => {
                    const system = e.target.value as SystemTab
                    const firstHeader = headers.find((h) => h.system === system && h.code !== (system === 'water_supply' ? 'consumer' : 'donor'))
                    setForm({ ...form, system, headerId: firstHeader?.id ?? '' })
                  }}
                  className="input-field"
                  disabled={!!editId}
                >
                  <option value="water_supply">{t('a.waterSupplySystem')}</option>
                  <option value="donors_projects">{t('ac.donorsSystem')}</option>
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant">{t('ac.accountHeader')}</label>
                  <button onClick={() => setShowHeaderForm(true)} className="text-[12.5px] font-sans font-semibold text-dp-secondary hover:text-dp-primary cursor-pointer">+ New Header</button>
                </div>
                <select value={form.headerId} onChange={(e) => setForm({ ...form, headerId: e.target.value })} className="input-field">
                  <option value="" disabled>{t('ac.selectHeader')}</option>
                  {headers.filter((h) => h.system === form.system && h.code !== (form.system === 'water_supply' ? 'consumer' : 'donor')).sort((a, b) => a.display_order - b.display_order).map((h) => (
                    <option key={h.id} value={h.id}>{h.label} ({h.code_prefix})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ac.nameEn')}</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ac.nameUr')}</label>
                <input value={form.name_ur ?? ''} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                {!form.name_ur?.trim() && (
                  <p className="text-[12px] font-sans text-amber-700 mt-1.5">Not set — this account will show in English even when Urdu is selected.</p>
                )}
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ac.openingBalance')}</label>
                <input type="number" value={form.opening_balance || ''} onChange={(e) => setForm({ ...form, opening_balance: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.description')}</label>
                <textarea value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" />
              </div>
              <button onClick={save} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {editId ? 'Save Changes' : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Account Header Modal */}
      {showHeaderForm && (
        <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={() => setShowHeaderForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('ac.newHeader')}</h2>
              <button onClick={() => setShowHeaderForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ac.labelEn')}</label>
                <input value={headerForm.label} onChange={(e) => setHeaderForm({ ...headerForm, label: e.target.value })} placeholder="e.g. Inventory" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ac.labelUr')}</label>
                <input value={headerForm.label_ur} onChange={(e) => setHeaderForm({ ...headerForm, label_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ac.shortCode')}</label>
                <input value={headerForm.code} onChange={(e) => setHeaderForm({ ...headerForm, code: e.target.value })} placeholder="e.g. inventory" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ac.codePrefix')}</label>
                <input value={headerForm.code_prefix} onChange={(e) => setHeaderForm({ ...headerForm, code_prefix: e.target.value.toUpperCase() })} placeholder={`e.g. ${form.system === 'water_supply' ? 'WS' : 'DP'}-INV`} className="input-field" />
              </div>
              <button onClick={saveHeader} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> {t('ac.createHeader')}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}
