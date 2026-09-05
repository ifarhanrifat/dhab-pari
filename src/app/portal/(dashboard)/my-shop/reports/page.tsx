'use client'

// Shop keeper's back-office: everything shop_dashboard_summary/
// shop_daily_earnings/shop_best_sellers (migration 393) compute, plus
// order/sale history read straight off shop_orders and shop_sales (RLS
// now lets a shop's own keeper read both — see the same migration).
// Balance/earnings numbers only ever come from those SECURITY DEFINER
// RPCs, never a direct read of accounts/ledger_entries — those stay
// closed to portal users everywhere in this app (182), on purpose.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { ArrowLeft, Wallet, TrendingUp, TrendingDown, Clock, Package, PackageX, PackagePlus, CheckCircle2, XCircle, Search } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { getCategoryLabel } from '@/lib/shopTypes'
import { OrderFulfillmentPanel } from '@/components/shared/OrderFulfillmentPanel'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Shop { id: string; name: string; name_ur: string | null; commission_mode: string }
interface Summary {
 balance_pkr: number; commission_mode: string; lumpsum_fee_pkr: number | null
 today_earnings_pkr: number; month_earnings_pkr: number; month_profit_pkr: number
 today_purchase_pkr?: number; stock_value_pkr?: number
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
type Period = 'today' | 'week' | 'month'
interface PeriodSaleRow { total_amount_pkr: number; created_at: string; shop_sale_items: { product_id: string | null; quantity: number; line_total_pkr: number }[] }
interface PeriodOrderRow { total_amount_pkr: number; confirmed_at: string | null; status: string; shop_order_items: { product_id: string | null; quantity: number; line_total_pkr: number }[] }
interface PeriodPurchaseRow { total_cost_pkr: number; created_at: string }
interface CatalogProduct { id: string; name: string; name_ur: string | null; category: string | null; cost_price_pkr: number; quantity_on_hand: number }

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
 const [period, setPeriod] = useState<Period>('today')
 const [periodSales, setPeriodSales] = useState<PeriodSaleRow[]>([])
 const [periodOrders, setPeriodOrders] = useState<PeriodOrderRow[]>([])
 const [periodPurchases, setPeriodPurchases] = useState<PeriodPurchaseRow[]>([])
 const [catalogProducts, setCatalogProducts] = useState<CatalogProduct[]>([])

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

 const cutoff31 = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()
 const [{ data: s }, { data: d }, { data: b }, { data: o }, { data: w }, { data: ps }, { data: po }, { data: pp }, { data: cp }] = await Promise.all([
 supabase.rpc('shop_dashboard_summary', { p_shop_id: data.id }),
 supabase.rpc('shop_daily_earnings', { p_shop_id: data.id, p_days: 14 }),
 supabase.rpc('shop_best_sellers', { p_shop_id: data.id, p_days: 1 }),
 supabase.from('shop_orders').select('id, status, total_amount_pkr, created_at, rejected_reason, fulfillment_status, delivery_address, buyer_mobile, shop_order_items(quantity, shop_products(name, name_ur))')
 .eq('shop_id', data.id).order('created_at', { ascending: false }).limit(20),
 supabase.from('shop_sales').select('id, total_amount_pkr, created_at, shop_sale_items(product_name_snapshot, quantity)')
 .eq('shop_id', data.id).order('created_at', { ascending: false }).limit(20),
 // Wide (31-day) raw fetches purely for the period control's own
 // aggregates below — filtered client-side per period rather than
 // re-querying the server on every تبدیلی, since a shop's own
 // month of activity is small enough to just hold in memory once.
 supabase.from('shop_sales').select('total_amount_pkr, created_at, shop_sale_items(product_id, quantity, line_total_pkr)')
 .eq('shop_id', data.id).gte('created_at', cutoff31),
 supabase.from('shop_orders').select('total_amount_pkr, confirmed_at, status, shop_order_items(product_id, quantity, line_total_pkr)')
 .eq('shop_id', data.id).eq('status', 'confirmed').gte('confirmed_at', cutoff31),
 supabase.from('shop_purchases').select('total_cost_pkr, created_at').eq('shop_id', data.id).gte('created_at', cutoff31),
 supabase.from('shop_products').select('id, name, name_ur, category, cost_price_pkr, quantity_on_hand').eq('shop_id', data.id).eq('is_active', true),
 ])
 setSummary(s as unknown as Summary)
 setDaily((d ?? []) as DayEarning[])
 setBestSellers((b ?? []) as BestSeller[])
 setOrders((o ?? []) as unknown as ShopOrder[])
 setSales((w ?? []) as unknown as WalkinSale[])
 setPeriodSales((ps ?? []) as unknown as PeriodSaleRow[])
 setPeriodOrders((po ?? []) as unknown as PeriodOrderRow[])
 setPeriodPurchases((pp ?? []) as PeriodPurchaseRow[])
 setCatalogProducts((cp ?? []) as CatalogProduct[])

 if (data.commission_mode === 'monthly_lumpsum') {
 const { data: demandData } = await supabase.rpc('marketplace_search_demand_report', { p_days: 30 })
 setDemand(demandData as { matched: DemandRow[]; unmatched: DemandRow[] })
 }
 setLoading(false)
 })
 }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

 // Best sellers is server-computed (it needs shop_sale_items/shop_order_items
 // joins the client doesn't have loaded at full 31-day depth) — refetch on
 // period change; everything else on this page derives from the wide
 // fetch above via periodCutoff/useMemo, no new request needed.
 useEffect(() => {
 if (!shop) return
 const days = period === 'today' ? 1 : period === 'week' ? 7 : 30
 supabase.rpc('shop_best_sellers', { p_shop_id: shop.id, p_days: days }).then(({ data }) => setBestSellers((data ?? []) as BestSeller[]))
 }, [period, shop]) // eslint-disable-line react-hooks/exhaustive-deps

 const periodCutoff = useMemo(() => {
 const now = new Date()
 if (period === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d }
 if (period === 'week') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
 return new Date(now.getFullYear(), now.getMonth(), 1)
 }, [period])

 const productById = useMemo(() => new Map(catalogProducts.map((p) => [p.id, p])), [catalogProducts])

 const periodStats = useMemo(() => {
 const sales = periodSales.filter((s) => new Date(s.created_at) >= periodCutoff)
 const orders = periodOrders.filter((o) => o.confirmed_at && new Date(o.confirmed_at) >= periodCutoff)
 const purchases = periodPurchases.filter((p) => new Date(p.created_at) >= periodCutoff)

 const saleTotal = sales.reduce((s, r) => s + r.total_amount_pkr, 0) + orders.reduce((s, r) => s + r.total_amount_pkr, 0)
 const purchaseTotal = purchases.reduce((s, r) => s + r.total_cost_pkr, 0)
 const bills = sales.length + orders.length

 const byCategory: Record<string, { qty: number; revenue: number; cost: number }> = {}
 let totalCost = 0
 for (const row of [...sales.flatMap((s) => s.shop_sale_items), ...orders.flatMap((o) => o.shop_order_items)]) {
 const product = row.product_id ? productById.get(row.product_id) : undefined
 const category = product?.category ?? 'other'
 const cost = (product?.cost_price_pkr ?? 0) * row.quantity
 totalCost += cost
 if (!byCategory[category]) byCategory[category] = { qty: 0, revenue: 0, cost: 0 }
 byCategory[category].qty += row.quantity
 byCategory[category].revenue += row.line_total_pkr
 byCategory[category].cost += cost
 }
 const categoryBreakdown = Object.entries(byCategory)
 .map(([category, v]) => ({ category, ...v, share: saleTotal > 0 ? (v.revenue / saleTotal) * 100 : 0 }))
 .sort((a, b) => b.revenue - a.revenue)

 const profit = saleTotal - totalCost
 return {
 saleTotal, purchaseTotal, profit, bills,
 avgBill: bills > 0 ? saleTotal / bills : 0,
 margin: saleTotal > 0 ? (profit / saleTotal) * 100 : 0,
 categoryBreakdown,
 }
 }, [periodSales, periodOrders, periodPurchases, periodCutoff, productById])

 const lowStockProducts = useMemo(() => catalogProducts.filter((p) => p.quantity_on_hand <= 5).sort((a, b) => a.quantity_on_hand - b.quantity_on_hand), [catalogProducts])

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

 if (userLoading || loading) return <div className="text-center py-12 text-[#7a736d] font-sans"><LoadingDots /></div>
 if (!shop) return <div className="text-center py-12 text-[#7a736d] font-sans">{t('sk.noShopLinked')}</div>

 const maxDaily = Math.max(1, ...daily.map((d) => d.walkin_pkr + d.marketplace_pkr))

 return (
 <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
 <Link href="/portal/my-shop" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-[#ec3013] hover:underline mb-3"><ArrowLeft size={14} /> {isUrdu && shop.name_ur ? shop.name_ur : shop.name}</Link>
 <h1 className="font-heading text-[24px] font-bold leading-[32px] text-[#201e1d] mb-1">{t('cm.reportsBtn')}</h1>
 <p className="font-sans text-[13px] text-[#7a736d] mb-5">{t('cm.reportsSubtitle')}</p>

 {/* Summary cards */}
 <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d] flex items-center gap-1"><Wallet size={12} /> {t('cm.balanceLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#201e1d] mt-1">{fmt(summary?.balance_pkr ?? 0)}</p>
 </div>
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d] flex items-center gap-1"><TrendingUp size={12} /> {t('cm.todayEarningsLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#ec3013] mt-1">{fmt(summary?.today_earnings_pkr ?? 0)}</p>
 </div>
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d]">{t('cm.monthEarningsLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#ec3013] mt-1">{fmt(summary?.month_earnings_pkr ?? 0)}</p>
 </div>
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d] flex items-center gap-1"><TrendingDown size={12} /> {t('cm.monthProfitLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#ec3013] mt-1">{fmt(summary?.month_profit_pkr ?? 0)}</p>
 </div>
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d] flex items-center gap-1"><PackagePlus size={12} /> {t('cm.todayPurchaseLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#201e1d] mt-1">{fmt(summary?.today_purchase_pkr ?? 0)}</p>
 </div>
 <div className="bg-white border border-[#dcd8d4] p-3.5">
 <p className="font-sans text-[11px] font-semibold text-[#7a736d] flex items-center gap-1"><Package size={12} /> {t('cm.stockValueLabel')}</p>
 <p className="font-heading text-[19px] font-bold text-[#201e1d] mt-1">{fmt(summary?.stock_value_pkr ?? 0)}</p>
 </div>
 </div>

 {/* Period control — drives everything below this point (sale,
 purchase, profit, bills, average bill, margin, category
 breakdown), matching the design's own آج/اس ہفتے/اس مہینے
 segmented control. The tiles above stay fixed to today/month
 since that's what the dashboard summary is for at a glance. */}
 <div className="flex items-center gap-1.5 mb-3 bg-[#eeece9] p-1 w-fit">
 {(['today', 'week', 'month'] as const).map((p) => (
 <button key={p} onClick={() => setPeriod(p)}
 className={`px-3.5 py-1.5 font-sans text-[12.5px] font-semibold cursor-pointer transition-all ${period === p ? 'bg-white text-[#ec3013] shadow-sm' : 'text-[#7a736d] hover:text-[#201e1d]'}`}>
 {p === 'today' ? t('cm.periodToday') : p === 'week' ? t('cm.periodWeek') : t('cm.periodMonth')}
 </button>
 ))}
 </div>

 <div className="bg-white border border-[#dcd8d4] p-4 mb-6">
 <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodSaleLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#ec3013]">{fmt(periodStats.saleTotal)}</p>
 </div>
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodPurchaseLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#201e1d]">{fmt(periodStats.purchaseTotal)}</p>
 </div>
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodProfitLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#ec3013]">{fmt(periodStats.profit)}</p>
 </div>
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodBillsLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#201e1d] ltr-num">{fmt(periodStats.bills)}</p>
 </div>
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodAvgBillLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#201e1d]">{fmt(periodStats.avgBill)}</p>
 </div>
 <div>
 <p className="font-sans text-[11px] text-[#7a736d]">{t('cm.periodMarginLabel')}</p>
 <p className="font-heading text-[18px] font-bold text-[#201e1d] ltr-num">{periodStats.margin.toFixed(0)}%</p>
 </div>
 </div>
 </div>

 {/* By category — proportional bars + share%, period-scoped */}
 {periodStats.categoryBreakdown.length > 0 && (
 <div className="mb-8">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5">{t('cm.byCategoryHeading')}</p>
 <div className="bg-white border border-[#dcd8d4] p-4 space-y-3">
 {periodStats.categoryBreakdown.map((c) => (
 <div key={c.category}>
 <div className="flex items-center justify-between gap-2 mb-1">
 <span className="font-sans text-[12.5px] font-semibold text-[#201e1d] truncate">{getCategoryLabel(c.category, isUrdu)}</span>
 <span className="font-sans text-[11.5px] text-[#7a736d] shrink-0 ltr-num">{fmt(c.revenue)} · {c.share.toFixed(0)}%</span>
 </div>
 <div className="h-2 bg-[#eeece9] overflow-hidden">
 <div className="h-full bg-[#ec3013] " style={{ width: `${Math.max(2, c.share)}%` }} />
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Low stock — with a direct shortcut into restocking, now that
 Purchase Entry exists. */}
 {lowStockProducts.length > 0 && (
 <div className="mb-8">
 <div className="flex items-center justify-between gap-3 mb-2.5">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em]">{t('cm.lowStockHeading')}</p>
 <Link href="/portal/my-shop/purchase" className="font-sans text-[12px] font-semibold text-[#ec3013] hover:underline">{t('cm.restockShortcutBtn')}</Link>
 </div>
 <div className="space-y-1.5">
 {lowStockProducts.map((p) => (
 <div key={p.id} className="flex items-center justify-between gap-3 bg-white border border-[#dcd8d4] px-3.5 py-2.5">
 <p className="font-sans text-[13px] text-[#201e1d] truncate">{isUrdu && p.name_ur ? p.name_ur : p.name}</p>
 <p className={`font-sans text-[12.5px] font-bold shrink-0 ltr-num ${p.quantity_on_hand <= 0 ? 'text-[#ae1800]' : 'text-[#201e1d]'}`}>{fmt(p.quantity_on_hand)}</p>
 </div>
 ))}
 </div>
 </div>
 )}

 {summary && (summary.pending_orders_count > 0 || summary.low_stock_count > 0 || summary.expiring_count > 0) && (
 <div className="flex flex-wrap gap-2 mb-6">
 {summary.pending_orders_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 bg-[#fce3dc] text-[#ae1800]"><Clock size={12} /> {summary.pending_orders_count} {t('cm.pendingOrdersTag')}</span>}
 {summary.low_stock_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 bg-[#fce3dc] text-[#ae1800]"><PackageX size={12} /> {summary.low_stock_count} {t('cm.lowStockTag')}</span>}
 {summary.expiring_count > 0 && <span className="inline-flex items-center gap-1 text-[12px] font-bold px-2.5 py-1 bg-[#fce3dc] text-[#ae1800]"><PackageX size={12} /> {summary.expiring_count} {t('cm.expiringTag')}</span>}
 </div>
 )}

 {summary?.commission_mode === 'monthly_lumpsum' && (
 <div className="bg-white border border-[#201e1d] p-3.5 mb-6">
 <p className="font-sans text-[13px] text-[#201e1d]">{t('cm.onLumpsumNote')} <span className="font-bold ltr-num">{fmt(summary.lumpsum_fee_pkr ?? 0)}</span></p>
 </div>
 )}

 {summary?.last_settlement_date && (
 <p className="font-sans text-[12.5px] text-[#7a736d] mb-6">{t('cm.lastSettlementLabel')} <span className="font-semibold text-[#201e1d]">{fmt(summary.last_settlement_amount ?? 0)}</span> — {new Date(summary.last_settlement_date).toLocaleDateString('en-GB')}</p>
 )}

 {/* Daily earnings bars */}
 <div className="mb-8">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5">{t('cm.dailyEarningsHeading')}</p>
 <div className="bg-white border border-[#dcd8d4] p-4 flex items-end gap-1.5 h-32">
 {daily.map((d) => {
 const total = d.walkin_pkr + d.marketplace_pkr
 const h = Math.max(2, Math.round((total / maxDaily) * 100))
 return (
 <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full group relative">
 <div className="w-full bg-[#ec3013]/80 " style={{ height: `${h}%` }} title={`${d.date}: ${fmt(total)}`} />
 </div>
 )
 })}
 </div>
 <div className="flex justify-between mt-1">
 <span className="font-sans text-[10.5px] text-[#7a736d]">{daily[0] ? new Date(daily[0].date).toLocaleDateString('en-GB') : ''}</span>
 <span className="font-sans text-[10.5px] text-[#7a736d]">{daily[daily.length - 1] ? new Date(daily[daily.length - 1].date).toLocaleDateString('en-GB') : ''}</span>
 </div>
 </div>

 {/* Best sellers */}
 {bestSellers.length > 0 && (
 <div className="mb-8">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5">{t('cm.bestSellersHeading')}</p>
 <div className="space-y-1.5">
 {bestSellers.map((b) => (
 <div key={b.product_id} className="flex items-center justify-between gap-3 bg-white border border-[#dcd8d4] px-3.5 py-2.5">
 <p className="font-sans text-[13px] text-[#201e1d] truncate">{b.name} <span className="text-[#7a736d]">× <span className="ltr-num">{fmt(b.quantity)}</span></span></p>
 <p className="font-sans text-[13.5px] font-bold text-[#ec3013] shrink-0">{fmt(b.revenue_pkr)}</p>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Demand insights — lumpsum perk only */}
 {demand && (
 <div className="mb-8">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Search size={13} /> {t('cm.demandHeading')}</p>
 <p className="font-sans text-[12.5px] text-[#7a736d] mb-3">{t('cm.demandSubtitle')}</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
 <div>
 <p className="font-sans text-[11.5px] font-bold text-[#ae1800] uppercase tracking-[0.04em] mb-2">{t('cm.demandUnmatchedHeading')}</p>
 {demand.unmatched.length === 0 && <p className="font-sans text-[12.5px] text-[#7a736d]">{t('cm.noDemandData')}</p>}
 <div className="space-y-1">
 {demand.unmatched.map((r, i) => (
 <div key={i} className="flex items-center justify-between gap-2 bg-white border border-[#dcd8d4] px-3 py-1.5">
 <span className="font-sans text-[12.5px] text-[#201e1d] truncate">{r.query}</span>
 <span className="font-sans text-[11.5px] font-bold text-[#7a736d] shrink-0 ltr-num">{r.searches}×</span>
 </div>
 ))}
 </div>
 </div>
 <div>
 <p className="font-sans text-[11.5px] font-bold text-[#7a736d] uppercase tracking-[0.04em] mb-2">{t('cm.demandMatchedHeading')}</p>
 {demand.matched.length === 0 && <p className="font-sans text-[12.5px] text-[#7a736d]">{t('cm.noDemandData')}</p>}
 <div className="space-y-1">
 {demand.matched.map((r, i) => (
 <div key={i} className="flex items-center justify-between gap-2 bg-white border border-[#dcd8d4] px-3 py-1.5">
 <span className="font-sans text-[12.5px] text-[#201e1d] truncate">{r.query}</span>
 <span className="font-sans text-[11.5px] font-bold text-[#7a736d] shrink-0 ltr-num">{r.searches}×</span>
 </div>
 ))}
 </div>
 </div>
 </div>
 </div>
 )}

 {/* Marketplace order history */}
 <div className="mb-8">
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5">{t('cm.orderHistoryHeading')}</p>
 {orders.length === 0 && <p className="font-sans text-[13px] text-[#7a736d]">{t('cm.noOrdersYet')}</p>}
 <div className="space-y-2">
 {orders.map((o) => (
 <div key={o.id} className="bg-white border border-[#dcd8d4] p-3.5">
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 {o.shop_order_items.map((it, i) => (
 <p key={i} className="font-sans text-[13px] text-[#201e1d] truncate">
 {isUrdu && it.shop_products?.name_ur ? it.shop_products.name_ur : it.shop_products?.name ?? '—'} × <span className="ltr-num">{it.quantity}</span>
 </p>
 ))}
 <p className="font-sans text-[11px] text-[#7a736d] mt-0.5">{new Date(o.created_at).toLocaleDateString('en-GB')}</p>
 </div>
 <div className="text-end shrink-0">
 <p className="font-sans text-[14px] font-bold text-[#ec3013]">{fmt(o.total_amount_pkr)}</p>
 {o.status === 'confirmed' && <span className="inline-flex items-center gap-1 text-[#ec3013] text-[11px] font-bold"><CheckCircle2 size={11} /> {t('mp.confirmedStatus')}</span>}
 {o.status === 'rejected' && <span className="inline-flex items-center gap-1 text-[#ae1800] text-[11px] font-bold" title={o.rejected_reason ?? undefined}><XCircle size={11} /> {t('mp.rejectedStatus')}</span>}
 {o.status === 'announced' && summary?.commission_mode !== 'per_order' && <span className="inline-flex items-center gap-1 text-[#201e1d] text-[11px] font-bold"><Clock size={11} /> {t('mp.awaitingStatus')}</span>}
 </div>
 </div>
 {o.status === 'announced' && summary?.commission_mode === 'per_order' && (
 <div className="flex items-center justify-between gap-2 mt-2.5 pt-2.5 border-t border-[#dcd8d4]/60">
 <span className="font-sans text-[11px] text-[#7a736d]">{t('cm.markFulfilledHint')}</span>
 <div className="flex items-center gap-1.5 shrink-0">
 <button onClick={() => cancelOrder(o.id)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer border border-[#dcd8d4] text-[#7a736d] hover:bg-[#eeece9] disabled:opacity-50">{t('mp.rejectBtn')}</button>
 <button onClick={() => fulfillOrder(o.id)} disabled={orderActionId === o.id} className="px-2.5 py-1 rounded text-[12px] font-sans font-semibold cursor-pointer bg-[#ec3013] text-white hover:opacity-90 disabled:opacity-50">{t('cm.markFulfilledBtn')}</button>
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
 <p className="font-sans text-[12px] font-bold text-[#7a736d] uppercase tracking-[0.05em] mb-2.5">{t('cm.salesHistoryHeading')}</p>
 {sales.length === 0 && <p className="font-sans text-[13px] text-[#7a736d]">{t('cm.noSalesYet')}</p>}
 <div className="space-y-2">
 {sales.map((s) => (
 <div key={s.id} className="bg-white border border-[#dcd8d4] p-3.5">
 <div className="flex items-start justify-between gap-3">
 <div className="min-w-0">
 {s.shop_sale_items.map((it, i) => (
 <p key={i} className="font-sans text-[13px] text-[#201e1d] truncate">{it.product_name_snapshot} × <span className="ltr-num">{fmt(it.quantity)}</span></p>
 ))}
 <p className="font-sans text-[11px] text-[#7a736d] mt-0.5">{new Date(s.created_at).toLocaleString('en-GB')}</p>
 </div>
 <p className="font-sans text-[14px] font-bold text-[#ec3013] shrink-0">{fmt(s.total_amount_pkr)}</p>
 </div>
 </div>
 ))}
 </div>
 </div>
 </div>
 )
}
