'use client'

// Customer credit ("khata") — migrations 452/453. A shopkeeper registers
// a regular customer once here, then at the counter (sell/page.tsx) can
// bill them "on credit" instead of cash — the sale still goes through
// record_shop_sale exactly as before, just tagged with this customer's
// id. This screen is the other half: the customer list with running
// balances, and per-customer statements + recording payments against
// what they owe. Confirmed design (2026-09-07): a running tab paid down
// whenever, not a fixed monthly billing cycle; partial payments allowed.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Users, Search, X, Plus, Loader2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarqueeText } from '@/components/shared/MarqueeText'

const INK = '#201e1d'
const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'

interface Shop { id: string; name: string; name_ur: string | null }
interface Customer { id: string; name: string; name_ur: string | null; phone: string | null; is_active: boolean; balance: number }
interface StatementRow { entry_id: string; entry_type: 'sale' | 'payment'; entry_at: string; description: string; debit: number; credit: number; running_balance: number }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function CustomersPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [newNameUr, setNewNameUr] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [saving, setSaving] = useState(false)

  const [openCustomer, setOpenCustomer] = useState<Customer | null>(null)
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [loadingStatement, setLoadingStatement] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentNote, setPaymentNote] = useState('')
  const [recordingPayment, setRecordingPayment] = useState(false)

  const loadCustomers = (shopId: string) =>
    supabase.rpc('shop_customers_with_balance', { p_shop_id: shopId }).then(({ data }) => setCustomers((data ?? []) as Customer[]))

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur').eq('portal_user_id', user.id).maybeSingle().then(({ data }) => {
      setShop(data)
      if (data) loadCustomers(data.id).then(() => setLoading(false))
      else setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const addCustomer = async () => {
    if (!shop || !newName.trim()) { toast.error(t('sk.customerNameRequired')); return }
    setSaving(true)
    const { error } = await supabase.from('shop_customers').insert({
      shop_id: shop.id, name: newName.trim(), name_ur: newNameUr.trim() || null, phone: newPhone.trim() || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNewName(''); setNewNameUr(''); setNewPhone(''); setShowNew(false)
    loadCustomers(shop.id)
  }

  const openStatement = async (c: Customer) => {
    setOpenCustomer(c)
    setPaymentAmount(''); setPaymentNote('')
    setLoadingStatement(true)
    const { data, error } = await supabase.rpc('shop_customer_statement', { p_customer_id: c.id })
    setLoadingStatement(false)
    if (error) { toast.error(friendlyError(error)); return }
    setStatement((data ?? []) as StatementRow[])
  }

  const recordPayment = async () => {
    if (!openCustomer) return
    const amount = Number(paymentAmount)
    if (!(amount > 0)) { toast.error(t('sk.paymentAmountRequired')); return }
    setRecordingPayment(true)
    const { error } = await supabase.rpc('record_shop_credit_payment', {
      p_customer_id: openCustomer.id, p_amount_pkr: amount, p_note: paymentNote.trim() || null,
    })
    setRecordingPayment(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.paymentRecordedToast'))
    setPaymentAmount(''); setPaymentNote('')
    openStatement(openCustomer)
    if (shop) loadCustomers(shop.id)
  }

  const filtered = search.trim()
    ? customers.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()) || (c.name_ur ?? '').includes(search) || (c.phone ?? '').includes(search))
    : customers
  // Whoever owes the most floats to the top — the actionable view for a
  // shopkeeper deciding who to remind.
  const sorted = [...filtered].sort((a, b) => b.balance - a.balance)
  const totalOwed = customers.reduce((s, c) => s + Math.max(c.balance, 0), 0)

  if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme pb-16">
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold hover:underline mb-3" style={{ color: ACCENT }}><ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] mb-1 flex items-center gap-2" style={{ color: INK }}><Users size={22} /> {t('sk.customersHeading')}</h1>
      <p className="font-sans text-[13px] text-[#7a736d] mb-4">{t('sk.customersSubtitle')}</p>

      {customers.length > 0 && (
        <div className="border p-3 mb-4" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
          <p className="font-sans text-[11px] font-semibold" style={{ color: ACCENT_DARK }}>{t('sk.totalOwedLabel')}</p>
          <p className="font-heading text-[22px] font-bold ltr-num" style={{ color: ACCENT_DARK }}>{fmt(totalOwed)}</p>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#7a736d] pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sk.searchCustomersPlaceholder')} className="input-field ps-9" />
        </div>
        <button onClick={() => setShowNew(true)} className="shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 text-white font-sans text-[13px] font-semibold cursor-pointer" style={{ background: ACCENT }}>
          <Plus size={15} /> {t('sk.newCustomerBtn')}
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="text-center py-10 text-[#7a736d] font-sans text-[14px]">{t('sk.noCustomersYetHint')}</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((c) => (
            <button key={c.id} onClick={() => openStatement(c)}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-3 bg-white border border-[#dcd8d4] text-start cursor-pointer hover:border-[#201e1d] transition-colors">
              <div className="min-w-0 flex-1">
                <MarqueeText text={isUrdu && c.name_ur ? c.name_ur : c.name} className="font-sans text-[14px] font-semibold" style={{ color: INK }} />
                {c.phone && <p className="font-sans text-[11px] text-[#7a736d] ltr-num">{c.phone}</p>}
              </div>
              <p className={`font-sans text-[15px] font-bold shrink-0 ltr-num ${c.balance > 0 ? '' : 'text-[#7a736d]'}`} style={c.balance > 0 ? { color: ACCENT_DARK } : undefined}>
                {c.balance === 0 ? t('sk.settledLabel') : fmt(c.balance)}
              </p>
            </button>
          ))}
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowNew(false)}>
          <div className="bg-white p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[18px] font-bold" style={{ color: INK }}>{t('sk.newCustomerBtn')}</h2>
              <button onClick={() => setShowNew(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-2.5">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('sk.customerNamePlaceholder')} className="input-field" />
              <input value={newNameUr} onChange={(e) => setNewNameUr(e.target.value)} placeholder={t('sk.customerNameUrPlaceholder')} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif' }} dir="rtl" />
              <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder={t('sk.customerPhonePlaceholder')} className="input-field ltr-num" dir="ltr" />
              <button onClick={addCustomer} disabled={saving} className="w-full text-white py-3 font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ background: ACCENT }}>
                {saving ? t('action.saving') : t('g.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {openCustomer && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setOpenCustomer(null)}>
          <div className="bg-white w-full sm:max-w-md max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: '#e2ded9' }}>
              <div className="min-w-0">
                <MarqueeText text={isUrdu && openCustomer.name_ur ? openCustomer.name_ur : openCustomer.name} className="font-heading text-[16px] font-bold" style={{ color: INK }} />
                {openCustomer.phone && <p className="font-sans text-[11px] text-[#7a736d] ltr-num">{openCustomer.phone}</p>}
              </div>
              <button onClick={() => setOpenCustomer(null)} className="cursor-pointer shrink-0"><X size={20} /></button>
            </div>

            <div className="p-4 border-b" style={{ borderColor: '#e2ded9', background: '#f7f6f5' }}>
              <p className="font-sans text-[11px] font-semibold text-[#7a736d]">{t('sk.currentBalanceLabel')}</p>
              <p className="font-heading text-[24px] font-bold ltr-num" style={{ color: openCustomer.balance > 0 ? ACCENT_DARK : INK }}>{fmt(openCustomer.balance)}</p>
              <div className="flex items-center gap-2 mt-3">
                <input inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder={t('sk.paymentAmountPlaceholder')} className="input-field flex-1 ltr-num" />
                <button onClick={recordPayment} disabled={recordingPayment} className="shrink-0 flex items-center gap-1.5 px-3.5 py-2.5 text-white font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50" style={{ background: INK }}>
                  {recordingPayment ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />} {t('sk.recordPaymentBtn')}
                </button>
              </div>
              <input value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} placeholder={t('sk.paymentNotePlaceholder')} className="input-field mt-2 text-[12px]" />
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <p className="font-sans text-[11px] font-bold uppercase tracking-[0.04em] text-[#7a736d] mb-2">{t('sk.statementHeading')}</p>
              {loadingStatement ? (
                <div className="py-6 text-center"><LoadingDots /></div>
              ) : statement.length === 0 ? (
                <p className="text-center py-6 text-[#7a736d] font-sans text-[13px]">{t('sk.noTransactionsYetHint')}</p>
              ) : (
                <div className="space-y-1.5">
                  {statement.map((r) => (
                    <div key={r.entry_id} className="flex items-center justify-between gap-2 px-2.5 py-2 border border-[#e2ded9]">
                      <div className="min-w-0">
                        <p className="font-sans text-[12.5px] font-semibold truncate" style={{ color: INK }}>{r.description}</p>
                        <p className="font-sans text-[10.5px] text-[#7a736d] ltr-num">
                          {new Date(r.entry_at).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <div className="text-end shrink-0">
                        <p className={`font-sans text-[13px] font-bold ltr-num ${r.entry_type === 'payment' ? 'text-emerald-700' : ''}`} style={r.entry_type === 'sale' ? { color: ACCENT_DARK } : undefined}>
                          {r.entry_type === 'payment' ? '−' : '+'}{fmt(r.debit || r.credit)}
                        </p>
                        <p className="font-sans text-[9.5px] text-[#7a736d] ltr-num">{t('sk.balanceAfterLabel')} {fmt(r.running_balance)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
