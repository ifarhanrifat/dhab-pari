'use client'

// Shop keeper's back-office: everything shop_dashboard_summary/
// shop_daily_earnings/shop_best_sellers (migration 393) compute, plus
// order/sale history read straight off shop_orders and shop_sales (RLS
// now lets a shop's own keeper read both — see the same migration).
// Balance/earnings numbers only ever come from those SECURITY DEFINER
// RPCs, never a direct read of accounts/ledger_entries — those stay
// closed to portal users everywhere in this app (182), on purpose.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Wallet, TrendingUp, TrendingDown, Clock, PackageX, CheckCircle2, XCircle, Search } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { OrderFulfillmentPanel } from '@/components/shared/OrderFulfillmentPanel'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null; commission_mode: string }
interface Summary {
  balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
  today_earnings_pkr: number; month_earnings_pkr: number; month_profit_pkr: number
  pending_orders_count: number; low_stock_count: number; expiring_count: number
  last_settlement_date: string | null; last_settlement_amount: number | null
}
interface DayEarning { date: string; walkin_pkr: number; marketplace_pkr: number }
interface BestSeller { product_id: string; name: string; quantity: number; revenue_pkr: number }
interface ShopOrder {
  id: string; status: string; total_amount_pkr: number; created_at: string; rejected_reason: string | null
  fulfillment_status: string; delivery_address: string | null; buyer_mobile: string | null
  shop_order_items: { quantity: number; shop_products: { name: string; name_ur: string | null } | null }[]
}
interface WalkinSale { id: string; total_amount_pkr: number; created_at: string; shop_sale_items: { product_name_snapshot: string; quantity: number }[] }
interface DemandRow { query: string; searches: number }

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function ShopReportsPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [shop, setShop] = useState<Shop | null>(null)
  const [loading, setLoading] = useState(true)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [daily, setDaily] = useState<DayEarning[]>([])
  const [bestSellers, setBestSellers] = useState<BestSeller[]>([])
  const [orders, setOrders] = useState<ShopOrder[]>([])
  const [sales, setSales] = useState<WalkinSale[]>([])
  const [demand, setDemand] = useState<{ matched: DemandRow[]; unmatched: DemandRow[] } | null>(null)
  const [orderActionId, setOrderActionId] = useState<string | null>(null)

  const reloadOrders = async (shopId: string) => {
    const [{ data: s }, { data: o }] = await Promise.all([
      supabase.rpc('shop_dashboard_summary', { p_shop_id: shopId }),
      supabase.from('shop_orders').select('id, status, total_amount_pkr, created_at, rejected_reason, fulfillment_status, delivery_address, buyer_mobile, shop_order_items(quantity, shop_products(name, name_ur))')
        .eq('shop_id', shopId).order('created_at', { ascending: false }).limit(20),
    ])
    setSummary(s as unknown as Summary)
    setOrders((o ?? []) as unknown as ShopOrder[])
  }

  useEffect(() => {
    if (!user) return
    supabase.from('shops').select('id, name, name_ur, commission_mode').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      setShop(data)
      if (!data) { setLoading(false); return }

      const [{ data: s }, { data: d }, { data: b }, { data: o }, { data: w }] = await Promise.all([
        supabase.rpc('shop_dashboard_summary', { p_shop_id: data.id }),
        supabase.rpc('shop_daily_earnings', { p_shop_id: data.id, p_days: 14 }),
        supabase.rpc('shop_best_sellers', { p_shop_id: data.id, p_days: 30 }),
        supabase.from('shop_orders').select('id, status, total_amount_pkr, created_at, rejected_reason, fulfillment_status, delivery_address, buyer_mobile, shop_order_items(quantity, shop_products(name, name_ur))')
          .eq('shop_id', data.id).order('created_at', { ascending: false }).limit(20),
        supabase.from('shop_sales').select('id, total_amount_pkr, created_at, shop_sale_items(product_name_snapshot, quantity)')
          .eq('shop_id', data.id).order('created_at', { ascending: false }).limit(20),
      ])
      setSummary(s as unknown as Summary)
      setDaily((d ?? []) as DayEarning[])
      setBestSellers((b ?? []) as BestSeller[])
      setOrders((o ?? []) as unknown as ShopOrder[])
      setSales((w ?? []) as unknown as WalkinSale[])

      if (data.commission_mode === 'monthly_lumpsum') {
        const { data: demandData } = await supabase.rpc('marketplace_search_demand_report', { p_days: 30 })
        setDemand(demandData as { matched: DemandRow[]; unmatched: DemandRow[] })
      }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  // Only meaningful for per_order orders — the shop's own keeper marks
  // them fulfilled themselves (no payment to verify, the customer already
  // paid them directly); a monthly_lumpsum order still needs staff.
  const fulfillOrder = async (orderId: string) => {
    setOrderActionId(orderId)
    const { error } = await supabase.rpc('confirm_shop_order', { p_order_id: orderId })
    setOrderActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.orderConfirmedToast'))
    if (shop) reloadOrders(shop.id)
  }
  const cancelOrder = async (orderId: string) => {
    const reason = window.prompt(t('mp.rejectReasonPrompt')) ?? ''
    setOrderActionId(orderId)
    const { error } = await supabase.rpc('reject_shop_order', { p_order_id: orderId, p_reason: reason || null })
    setOrderActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mp.orderRejectedToast'))
    if (shop) reloadOrders(shop.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!shop) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('sk.noShopLinked')}</div>

  const maxDaily = Math.max(1, ...daily.map((d) => d.walkin_pkr + d.marketplace_pkr))

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3"><ArrowLeft size={14} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
      <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-1">{t('cm.reportsBtn')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('cm.reportsSubtitle')}</p>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><Wallet size={12} /> {t('cm.balanceLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-primary mt-1">{fmt(summary?.balance_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><TrendingUp size={12} /> {t('cm.todayEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant">{t('cm.monthEarningsLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-dp-secondary mt-1">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
          <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant flex items-center gap-1"><TrendingDown size={12} /> {t('cm.monthProfitLabel')}</p>
          <p className="font-heading text-[19px] font-bold text-emerald-700 mt-1">{fmt(summary?.month_profit_pkr ?? 0)}</p>
        </div>
      </div>

      {summary && (summary.pending_orders_count > 0 || summary.low_stock_count > 0 || summary.expiring_count > 0) && (
        <div className="flex flex-wrap gap-2 mb-6">
          {summary.pending_orders_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800"><Clock size={12} /> {summary.pending_orders_count} {t('cm.pendingOrdersTag')}</span>}
          {summary.low_stock_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 rounded-full bg-red-100 text-red-700"><PackageX size={12} /> {summary.low_stock_count} {t('cm.lowStockTag')}</span>}
          {summary.expiring_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800"><PackageX size={12} /> {summary.expiring_count} {t('cm.expiringTag')}</span>}
        </div>
      )}

      {summary?.commission_mode === 'monthly_lumpsum' && (
        <div className="bg-violet-50 border border-violet-200 rounded-lg p-3.5 mb-6">
          <p className="font-sans text-[13px] text-violet-900">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
        </div>
      )}

      {summary?.last_settlement_date && (
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-6">{t('cm.lastSettlementLabel')} <span className="font-semibold text-dp-on-surface">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
      )}

      {/* Daily earnings bars */}
      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.dailyEarningsHeading')}</p>
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-end gap-1.5 h-32">
          {daily.map((d) => {
            const total = d.walkin_pkr + d.marketplace_pkr
            const h = Math.max(2, Math.round((total / maxDaily) * 100))
            return (
              <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                <div className="w-full bg-dp-secondary/80 rounded-t" style={{ height: `${h}%` }} title={`${d.date}: ${fmt(total)}`} />
              </div>
            )
          })}
        </div>
        <div className="flex justify-between mt-1">
          <span className="font-sans text-[10.5px] text-dp-on-surface-variant">{daily[0] ? new Date(daily[0].date).toLocaleDateString('en-GB') : ''}</span>
          <span className="font-sans text-[10.5px] text-dp-on-surface-variant">{daily[daily.length - 1] ? new Date(daily[daily.length - 1].date).toLocaleDateString('en-GB') : ''}</span>
        </div>
      </div>

      {/* Best sellers */}
      {bestSellers.length > 0 && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.bestSellersHeading')}</p>
          <div className="space-y-1.5">
            {bestSellers.map((b) => (
              <div key={b.product_id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg px-3.5 py-2.5">
                <p className="font-sans text-[13px] text-dp-on-surface truncate">{b.name} <span className="text-dp-on-surface-variant">× <span className="ltr-num">{fmt(b.quantity)}</span></span></p>
                <p className="font-sans text-[13.5px] font-bold text-dp-secondary shrink-0">{fmt(b.revenue_pkr)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Demand insights — lumpsum perk only */}
      {demand && (
        <div className="mb-8">
          <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Search size={13} /> {t('cm.demandHeading')}</p>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('cm.demandSubtitle')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="font-sans text-[11.5px] font-bold text-dp-error uppercase tracking-[0.04em] mb-2">{t('cm.demandUnmatchedHeading')}</p>
              {demand.unmatched.length === 0 && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('cm.noDemandData')}</p>}
              <div className="space-y-1">
                {demand.unmatched.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-white border border-dp-outline-variant rounded-lg px-3 py-1.5">
                    <span className="font-sans text-[12.5px] text-dp-on-surface truncate">{r.query}</span>
                    <span className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant shrink-0 ltr-num">{r.searches}×</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-[0.04em] mb-2">{t('cm.demandMatchedHeading')}</p>
              {demand.matched.length === 0 && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('cm.noDemandData')}</p>}
              <div className="space-y-1">
                {demand.matched.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-white border border-dp-outline-variant rounded-lg px-3 py-1.5">
                    <span className="font-sans text-[12.5px] text-dp-on-surface truncate">{r.query}</span>
                    <span className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant shrink-0 ltr-num">{r.searches}×</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Marketplace order history */}
      <div className="mb-8">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.orderHistoryHeading')}</p>
        {orders.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noOrdersYet')}</p>}
        <div className="space-y-2">
          {orders.map((o) => (
            <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {o.shop_order_items.map((it, i) => (
                    <p key={i} className="font-sans text-[13px] text-dp-on-surface truncate">
                      {isUrdu && it.shop_products?.name_ur ? it.shop_products.name_ur : it.shop_products?.name ?? '—'} × <span className="ltr-num">{it.quantity}</span>
                    </p>
                  ))}
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-0.5">{new Date(o.created_at).toLocaleDateString('en-GB')}</p>
                </div>
                <div className="text-end shrink-0">
                  <p className="font-sans text-[14px] font-bold text-dp-secondary">{fmt(o.total_amount_pkr)}</p>
                  {o.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-emerald-700 text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
                  {o.status === 'rejected' && <span className="inline-flex items-center gap-1 text-dp-error text-[11px] font-bold" title={o.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
                  {o.status === 'announced' && summary?.commission_mode !== 'per_order' && <span className="inline-flex items-center gap-1 text-amber-700 text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
                </div>
              </div>
              {o.status === 'announced' && summary?.commission_mode === 'per_order' && (
                <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-dp-outline-variant/60">
                  <span className="font-sans text-[11px] text-dp-on-surface-variant">{t('cm.markFulfilledHint')}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => cancelOrder(o.id)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container disabled:opacity-50">{t('mp.rejectBtn')}</button>
                    <button onClick={() => fulfillOrder(o.id)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
                  </div>
                </div>
              )}
              <OrderFulfillmentPanel order={o} onChanged={() => shop && reloadOrders(shop.id)} />
            </div>
          ))}
        </div>
      </div>

      {/* Walk-in sales history */}
      <div>
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('cm.salesHistoryHeading')}</p>
        {sales.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('cm.noSalesYet')}</p>}
        <div className="space-y-2">
          {sales.map((s) => (
            <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {s.shop_sale_items.map((it, i) => (
                    <p key={i} className="font-sans text-[13px] text-dp-on-surface truncate">{it.product_name_snapshot} × <span className="ltr-num">{fmt(it.quantity)}</span></p>
                  ))}
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-0.5">{new Date(s.created_at).toLocaleString('en-GB')}</p>
                </div>
                <p className="font-sans text-[14px] font-bold text-dp-secondary shrink-0">{fmt(s.total_amount_pkr)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
