'use client'

// The buyer's own side of shop_customers linking (migration 463) — a
// villager whose shopkeeper linked their udhar/credit record to this
// portal account can see the exact same statement the shopkeeper sees,
// read-only. Payments and corrections still only happen at the shop
// counter; this is visibility, not a new way to pay. Customers with no
// linked account (the default) never appear here at all — nothing here
// changes how the shop-side credit system works for them.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Wallet, X, ChevronDown, ChevronUp, Loader2, KeyRound, Receipt, Users, Link2Off } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MarqueeText } from '@/components/shared/MarqueeText'

const ACCENT = '#ec3013'
const ACCENT_DARK = '#ae1800'
const INK = '#201e1d'

// linked_count includes the viewer themselves — several household members
// (migration 466) can share one account, so this is just enough for basic
// transparency ("this isn't only yours"), never who else it is.
interface Account { customer_id: string; shop_id: string; shop_name: string; shop_name_ur: string | null; balance: number; linked_count: number }
interface StatementRow { entry_id: string; entry_type: 'sale' | 'payment' | 'invoice'; entry_at: string; description: string; debit: number; credit: number; running_balance: number }
interface SaleItem { id: string; product_id: string; product_name_snapshot: string; quantity: number; unit_price_pkr: number; line_total_pkr: number; pack_id: string | null; pack_label_snapshot: string | null }
// Unlike the shopkeeper's own anonymized "User N" view, a linked
// household member sees the OTHER real people who share this account —
// they already chose to give each other access by handing round a code,
// so real names/numbers here are the point, not a leak.
interface SharedLink { link_id: string; full_name: string; mobile: string; linked_at: string; is_me: boolean }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyCreditPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)

  const [showRedeem, setShowRedeem] = useState(false)
  const [code, setCode] = useState('')
  const [redeeming, setRedeeming] = useState(false)

  const [open, setOpen] = useState<Account | null>(null)
  const [statement, setStatement] = useState<StatementRow[]>([])
  const [loadingStatement, setLoadingStatement] = useState(false)
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null)
  const [saleItemsCache, setSaleItemsCache] = useState<Record<string, SaleItem[]>>({})
  const [loadingSaleId, setLoadingSaleId] = useState<string | null>(null)

  const [showSharedLinks, setShowSharedLinks] = useState(false)
  const [sharedLinks, setSharedLinks] = useState<SharedLink[]>([])
  const [loadingSharedLinks, setLoadingSharedLinks] = useState(false)
  const [removingLinkId, setRemovingLinkId] = useState<string | null>(null)

  const loadAccounts = () => supabase.rpc('my_credit_accounts').then(({ data }) => setAccounts((data ?? []) as Account[]))

  useEffect(() => {
    if (!user) return
    loadAccounts().then(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const redeem = async () => {
    if (!code.trim()) return
    setRedeeming(true)
    const { data, error } = await supabase.rpc('redeem_customer_link_code', { p_code: code.trim() })
    setRedeeming(false)
    if (error) { toast.error(friendlyError(error)); return }
    const row = Array.isArray(data) ? data[0] : data
    const shopName = isUrdu && row?.shop_name_ur ? row.shop_name_ur : row?.shop_name
    toast.success(t('sk.redeemSuccessToast').replace('{shop}', shopName ?? ''))
    setCode(''); setShowRedeem(false)
    loadAccounts()
  }

  const openStatement = async (a: Account) => {
    setOpen(a)
    setShowSharedLinks(false); setSharedLinks([])
    setLoadingStatement(true)
    const { data, error } = await supabase.rpc('shop_customer_statement', { p_customer_id: a.customer_id })
    setLoadingStatement(false)
    if (error) { toast.error(friendlyError(error)); return }
    setStatement((data ?? []) as StatementRow[])
  }

  const loadSharedLinks = async (customerId: string) => {
    setLoadingSharedLinks(true)
    const { data, error } = await supabase.rpc('list_shared_customer_links', { p_customer_id: customerId })
    setLoadingSharedLinks(false)
    if (error) { toast.error(friendlyError(error)); return }
    setSharedLinks((data ?? []) as SharedLink[])
  }

  const toggleSharedLinks = () => {
    if (!open) return
    if (!showSharedLinks) loadSharedLinks(open.customer_id)
    setShowSharedLinks((v) => !v)
  }

  // Any linked household member can remove any link on this account,
  // including their own — the same way any of them could already just
  // ask the shopkeeper to. Removing yourself closes the statement and
  // drops the account from the list, since access is gone the moment
  // this returns.
  const removeSharedLink = async (row: SharedLink) => {
    if (!open) return
    const confirmMsg = row.is_me ? t('sk.confirmRemoveSelfLink') : t('sk.confirmRemovePeerLink').replace('{name}', row.full_name)
    if (!confirm(confirmMsg)) return
    setRemovingLinkId(row.link_id)
    const { error } = await supabase.rpc('unlink_shared_customer_link', { p_link_id: row.link_id })
    setRemovingLinkId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sk.linkRemovedToast'))
    if (row.is_me) {
      setOpen(null)
      loadAccounts()
    } else {
      setSharedLinks((rows) => rows.filter((r) => r.link_id !== row.link_id))
      setOpen((a) => a ? { ...a, linked_count: Math.max(1, a.linked_count - 1) } : a)
    }
  }

  const loadSaleItems = async (saleId: string) => {
    if (saleItemsCache[saleId]) return
    setLoadingSaleId(saleId)
    const { data } = await supabase.from('shop_sale_items')
      .select('id, product_id, product_name_snapshot, quantity, unit_price_pkr, line_total_pkr, pack_id, pack_label_snapshot')
      .eq('sale_id', saleId)
    setLoadingSaleId(null)
    setSaleItemsCache((c) => ({ ...c, [saleId]: (data ?? []) as SaleItem[] }))
  }

  const toggleSaleExpand = async (saleId: string) => {
    if (expandedSaleId === saleId) { setExpandedSaleId(null); return }
    setExpandedSaleId(saleId)
    await loadSaleItems(saleId)
  }

  const totalOwed = accounts.reduce((s, a) => s + Math.max(a.balance, 0), 0)

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-1">
        <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2"><Wallet size={22} /> {t('sk.myCreditHeading')}</h1>
      </div>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('sk.myCreditSubtitle')}</p>

      {accounts.length > 0 && (
        <div className="border p-3 mb-4 rounded-lg" style={{ borderColor: '#f4a68f', background: '#fce3dc' }}>
          <p className="font-sans text-[11px] font-semibold" style={{ color: ACCENT_DARK }}>{t('sk.totalOwedLabel')}</p>
          <p className="font-heading text-[22px] font-bold ltr-num" style={{ color: ACCENT_DARK }}>{fmt(totalOwed)}</p>
        </div>
      )}

      {accounts.length === 0 ? (
        <p className="text-center py-8 text-dp-on-surface-variant font-sans text-[14px]">{t('sk.noCreditAccountsHint')}</p>
      ) : (
        <div className="space-y-1.5 mb-4">
          {accounts.map((a) => (
            <button key={a.customer_id} onClick={() => openStatement(a)}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-3 bg-white border border-dp-outline-variant rounded-lg text-start cursor-pointer hover:border-dp-secondary transition-colors">
              <MarqueeText text={isUrdu && a.shop_name_ur ? a.shop_name_ur : a.shop_name} className="font-sans text-[14px] font-semibold min-w-0 flex-1" style={{ color: INK }} />
              <p className={`font-sans text-[15px] font-bold shrink-0 ltr-num ${a.balance > 0 ? '' : 'text-dp-on-surface-variant'}`} style={a.balance > 0 ? { color: ACCENT_DARK } : undefined}>
                {a.balance === 0 ? t('sk.settledLabel') : fmt(a.balance)}
              </p>
            </button>
          ))}
        </div>
      )}

      <button onClick={() => setShowRedeem(true)} className="w-full flex items-center justify-center gap-1.5 py-3 border border-dashed rounded-lg font-sans text-[13px] font-semibold cursor-pointer border-dp-secondary text-dp-secondary">
        <KeyRound size={14} /> {t('sk.redeemCodeBtn')}
      </button>

      {showRedeem && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowRedeem(false)}>
          <div className="bg-white p-5 w-full max-w-sm rounded-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-[18px] font-bold" style={{ color: INK }}>{t('sk.redeemCodeTitle')}</h2>
              <button onClick={() => setShowRedeem(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2.5">{t('sk.redeemCodeHint')}</p>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('sk.redeemCodePlaceholder')} inputMode="numeric" maxLength={6}
              className="input-field text-center text-[22px] tracking-[0.2em] ltr-num" dir="ltr" />
            <button onClick={redeem} disabled={redeeming || !code.trim()} className="w-full mt-3 text-white py-3 rounded-lg font-sans font-semibold cursor-pointer disabled:opacity-50" style={{ background: ACCENT }}>
              {redeeming ? <Loader2 size={16} className="animate-spin mx-auto" /> : t('g.saveChanges')}
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setOpen(null)}>
          <div className="bg-white w-full sm:max-w-md max-h-[90vh] flex flex-col rounded-t-lg sm:rounded-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-dp-outline-variant">
              <MarqueeText text={isUrdu && open.shop_name_ur ? open.shop_name_ur : open.shop_name} className="font-heading text-[16px] font-bold min-w-0 flex-1" style={{ color: INK }} />
              <button onClick={() => setOpen(null)} className="cursor-pointer shrink-0"><X size={20} /></button>
            </div>
            <div className="p-4 border-b border-dp-outline-variant bg-dp-surface-container-low">
              <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant">{t('sk.currentBalanceLabel')}</p>
              <p className="font-heading text-[24px] font-bold ltr-num" style={{ color: open.balance > 0 ? ACCENT_DARK : INK }}>{fmt(open.balance)}</p>
              <p className="font-sans text-[10.5px] text-dp-on-surface-variant mt-1">{t('sk.viewOnlyStatementHint')}</p>

              <button onClick={toggleSharedLinks} className="w-full flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant cursor-pointer">
                <span className="flex items-center gap-1.5 font-sans text-[11.5px] font-semibold text-dp-secondary">
                  <Users size={13} /> {t('sk.linkedCountLabel').replace('{n}', String(open.linked_count))}
                </span>
                {showSharedLinks ? <ChevronUp size={14} className="text-dp-secondary" /> : <ChevronDown size={14} className="text-dp-secondary" />}
              </button>
              {showSharedLinks && (
                <div className="mt-2 space-y-1">
                  {loadingSharedLinks ? (
                    <div className="py-2 text-center"><LoadingDots /></div>
                  ) : sharedLinks.map((row) => (
                    <div key={row.link_id} className="flex items-center justify-between gap-2 px-2.5 py-2 bg-white border border-dp-outline-variant rounded-lg">
                      <div className="min-w-0">
                        <p className="font-sans text-[12.5px] font-semibold" style={{ color: INK }}>{row.is_me ? t('sk.youLabel') : row.full_name}</p>
                        <p className="font-sans text-[10.5px] text-dp-on-surface-variant ltr-num">{row.mobile}</p>
                      </div>
                      <button onClick={() => removeSharedLink(row)} disabled={removingLinkId === row.link_id} className="shrink-0 flex items-center gap-1 font-sans text-[10.5px] font-semibold underline cursor-pointer disabled:opacity-50" style={{ color: ACCENT_DARK }}>
                        {removingLinkId === row.link_id ? <Loader2 size={11} className="animate-spin" /> : <Link2Off size={11} />} {t('sk.unlinkBtn')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {loadingStatement ? (
                <div className="py-6 text-center"><LoadingDots /></div>
              ) : statement.length === 0 ? (
                <p className="text-center py-6 text-dp-on-surface-variant font-sans text-[13px]">{t('sk.noTransactionsYetHint')}</p>
              ) : (
                <div className="space-y-1.5">
                  {statement.map((r) => {
                    if (r.entry_type === 'invoice') {
                      return (
                        <div key={r.entry_id} className="flex items-center gap-2 px-2.5 py-2 border-2 border-dashed" style={{ borderColor: ACCENT }}>
                          <Receipt size={15} style={{ color: ACCENT }} className="shrink-0" />
                          <span className="flex-1 min-w-0 font-sans text-[12.5px] font-semibold truncate" style={{ color: ACCENT_DARK }}>{r.description}</span>
                        </div>
                      )
                    }
                    const expanded = expandedSaleId === r.entry_id
                    return (
                      <div key={r.entry_id} className="border border-dp-outline-variant">
                        <button onClick={() => r.entry_type === 'sale' ? toggleSaleExpand(r.entry_id) : undefined}
                          className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-start ${r.entry_type === 'sale' ? 'cursor-pointer' : ''}`}>
                          <div className="min-w-0 flex-1 flex items-center gap-1.5">
                            {r.entry_type === 'sale' && (loadingSaleId === r.entry_id ? <Loader2 size={12} className="animate-spin shrink-0" /> : expanded ? <ChevronUp size={13} className="shrink-0 text-dp-on-surface-variant" /> : <ChevronDown size={13} className="shrink-0 text-dp-on-surface-variant" />)}
                            <div className="min-w-0">
                              <p className="font-sans text-[12.5px] font-semibold truncate" style={{ color: INK }}>{r.description}</p>
                              <p className="font-sans text-[10.5px] text-dp-on-surface-variant ltr-num">
                                {new Date(r.entry_at).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </div>
                          <div className="text-end shrink-0">
                            <p className={`font-sans text-[13px] font-bold ltr-num ${r.entry_type === 'payment' ? 'text-emerald-700' : ''}`} style={r.entry_type === 'sale' ? { color: ACCENT_DARK } : undefined}>
                              {r.entry_type === 'payment' ? '−' : '+'}{fmt(r.debit || r.credit)}
                            </p>
                            <p className="font-sans text-[9.5px] text-dp-on-surface-variant ltr-num">{t('sk.balanceAfterLabel')} {fmt(r.running_balance)}</p>
                          </div>
                        </button>
                        {expanded && (
                          <div className="border-t border-dp-outline-variant bg-dp-surface-container-low px-2.5 py-2">
                            {(saleItemsCache[r.entry_id] ?? []).map((it) => (
                              <div key={it.id} className="flex items-center justify-between gap-2 py-1">
                                <span className="min-w-0 flex-1 font-sans text-[11.5px] truncate" style={{ color: INK }}>
                                  {it.product_name_snapshot}{it.pack_label_snapshot && ` (${it.pack_label_snapshot})`}
                                </span>
                                <span className="shrink-0 font-sans text-[11px] text-dp-on-surface-variant ltr-num">{fmt(it.quantity)} × {fmt(it.unit_price_pkr)} = <strong style={{ color: INK }}>{fmt(it.line_total_pkr)}</strong></span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
