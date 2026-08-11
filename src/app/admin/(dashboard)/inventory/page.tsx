'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Save, Boxes, Wrench, Layers, ShoppingCart, Trash2, Star, History, LineChart as LineChartIcon, AlertTriangle, Trophy } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { StockValueTrendChart } from '@/components/admin/DashboardCharts'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type Tab = 'items' | 'services' | 'templates' | 'movements' | 'analytics'
type TopSellingPeriod = 'month' | '90d' | 'all'

interface InventoryItem {
  id: string; item_code: string; name: string; unit: string
  unit_cost: number; unit_price: number; quantity_on_hand: number; reorder_level: number; is_active: boolean
  is_connection_essential: boolean
}
interface ServiceItem {
  id: string; service_code: string; name: string; charge_amount: number; description: string | null; is_active: boolean
}
interface ConnectionTemplate { id: string; name: string; is_default: boolean }
interface TemplateItem {
  id: string; template_id: string; item_type: 'inventory' | 'service'
  inventory_item_id: string | null; service_item_id: string | null; quantity: number
}
interface Movement {
  id: string; item_id: string; txn_type: string; quantity: number
  unit_cost_at_time: number | null; txn_date: string; note: string | null; created_at: string
}
interface StockValuePoint { month: string; value: number }
interface TopSellingItem { itemId: string; name: string; itemCode: string; quantitySold: number; revenue: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const emptyItemForm = { name: '', unit: 'piece', unit_cost: 0, unit_price: 0, reorder_level: 0 }
const emptyServiceForm = { name: '', charge_amount: 0, description: '' }
const emptyPurchaseForm = { quantity: 0, unit_cost_at_time: 0, method: 'cash', note: '' }

export default function InventoryPage() {
  const { t: tr } = useLocale()
  const access = useSystemAccess()
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'items'
    const p = new URLSearchParams(window.location.search).get('tab')
    return p === 'analytics' || p === 'items' || p === 'services' || p === 'templates' || p === 'movements' ? p : 'items'
  })
  const [items, setItems] = useState<InventoryItem[]>([])
  const [services, setServices] = useState<ServiceItem[]>([])
  const [templates, setTemplates] = useState<ConnectionTemplate[]>([])
  const [templateItems, setTemplateItems] = useState<TemplateItem[]>([])
  const [movements, setMovements] = useState<Movement[]>([])
  const [movementItemFilter, setMovementItemFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [stockTrend, setStockTrend] = useState<StockValuePoint[]>([])
  const [topSelling, setTopSelling] = useState<TopSellingItem[]>([])
  const [topSellingPeriod, setTopSellingPeriod] = useState<TopSellingPeriod>('all')
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const supabase = createClient()

  const [showItemForm, setShowItemForm] = useState(false)
  const [itemForm, setItemForm] = useState(emptyItemForm)
  const [showServiceForm, setShowServiceForm] = useState(false)
  const [serviceForm, setServiceForm] = useState(emptyServiceForm)
  const [purchaseFor, setPurchaseFor] = useState<InventoryItem | null>(null)
  const [purchaseForm, setPurchaseForm] = useState(emptyPurchaseForm)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<{ table: string; id: string } | null>(null)
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [showAddTemplate, setShowAddTemplate] = useState(false)
  const [addLineForm, setAddLineForm] = useState<{ item_type: 'inventory' | 'service'; ref_id: string; quantity: number }>({ item_type: 'inventory', ref_id: '', quantity: 1 })

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: itemsData }, { data: servicesData }, { data: templatesData }, { data: templateItemsData }, { data: movementsData }] = await Promise.all([
      supabase.from('inventory_items').select('*').eq('system', 'water_supply').order('item_code'),
      supabase.from('service_items').select('*').eq('system', 'water_supply').order('service_code'),
      supabase.from('connection_templates').select('*').eq('system', 'water_supply').order('name'),
      supabase.from('connection_template_items').select('*'),
      supabase.from('inventory_transactions')
        .select('id, item_id, txn_type, quantity, unit_cost_at_time, txn_date, note, created_at')
        .order('created_at', { ascending: false }).limit(200),
    ])
    setItems(itemsData ?? [])
    setServices(servicesData ?? [])
    setTemplates(templatesData ?? [])
    setTemplateItems(templateItemsData ?? [])
    // inventory_transactions has no system column of its own — filter to this
    // system's items client-side (the page only ever shows water_supply).
    const waterSupplyItemIds = new Set((itemsData ?? []).map((i) => i.id))
    setMovements((movementsData ?? []).filter((m) => waterSupplyItemIds.has(m.item_id)))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const lowStockItems = useMemo(
    () => items.filter((i) => i.is_active && i.reorder_level > 0 && i.quantity_on_hand <= i.reorder_level),
    [items]
  )

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true)
    const [{ data: acct }, lineItemsRes] = await Promise.all([
      supabase.from('accounts').select('id, opening_balance').eq('system', 'water_supply').eq('code', 'WS-4002').single(),
      (() => {
        let q = supabase.from('bill_line_items').select('inventory_item_id, quantity, line_total, created_at').eq('item_type', 'inventory')
        if (topSellingPeriod === 'month') {
          const d = new Date(); d.setDate(1)
          q = q.gte('created_at', d.toISOString())
        } else if (topSellingPeriod === '90d') {
          const d = new Date(); d.setDate(d.getDate() - 90)
          q = q.gte('created_at', d.toISOString())
        }
        return q
      })(),
    ])

    // Stock Value Trend — the Inventory Stock GL account's running balance at
    // each of the last 6 month-ends, computed the same way as opening_balance +
    // cumulative debit-credit (asset accounts are debit-normal).
    if (acct) {
      const { data: entries } = await supabase
        .from('ledger_entries').select('entry_date, debit, credit')
        .eq('account_id', acct.id).order('entry_date', { ascending: true })
      const sorted = entries ?? []
      const months: { key: string; label: string; end: Date }[] = []
      const now = new Date()
      for (let i = 5; i >= 0; i--) {
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0)
        months.push({ key: `${end.getFullYear()}-${end.getMonth()}`, label: end.toLocaleDateString('en-US', { month: 'short' }), end })
      }
      let running = Number(acct.opening_balance)
      let idx = 0
      const points: StockValuePoint[] = []
      for (const m of months) {
        while (idx < sorted.length && new Date(sorted[idx].entry_date) <= m.end) {
          running += Number(sorted[idx].debit) - Number(sorted[idx].credit)
          idx++
        }
        points.push({ month: m.label, value: Math.max(running, 0) })
      }
      setStockTrend(points)
    } else {
      setStockTrend([])
    }

    // Top Selling Inventory — ranked by actual billed revenue (line_total
    // already nets out any per-item discount), not reconstructed from cost.
    const itemNameById = Object.fromEntries(items.map((i) => [i.id, { name: i.name, itemCode: i.item_code }]))
    const agg: Record<string, { quantitySold: number; revenue: number }> = {}
    for (const r of lineItemsRes.data ?? []) {
      if (!r.inventory_item_id) continue
      const cur = agg[r.inventory_item_id] ?? { quantitySold: 0, revenue: 0 }
      cur.quantitySold += Number(r.quantity)
      cur.revenue += Number(r.line_total)
      agg[r.inventory_item_id] = cur
    }
    const ranked = Object.entries(agg)
      .map(([itemId, v]) => ({ itemId, name: itemNameById[itemId]?.name ?? 'Deleted Item', itemCode: itemNameById[itemId]?.itemCode ?? '—', ...v }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
    setTopSelling(ranked)
    setAnalyticsLoading(false)
  }, [supabase, topSellingPeriod, items])

  useEffect(() => {
    if (tab === 'analytics' && items.length > 0) loadAnalytics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, topSellingPeriod, items.length])

  const saveItem = async () => {
    if (!itemForm.name.trim()) { toast.error('Item name required'); return }
    const { error } = await supabase.from('inventory_items').insert({ system: 'water_supply', ...itemForm })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Item added')
    setShowItemForm(false)
    setItemForm(emptyItemForm)
    load()
  }

  const saveService = async () => {
    if (!serviceForm.name.trim()) { toast.error('Service name required'); return }
    const { error } = await supabase.from('service_items').insert({ system: 'water_supply', ...serviceForm, description: serviceForm.description || null })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Service added')
    setShowServiceForm(false)
    setServiceForm(emptyServiceForm)
    load()
  }

  const toggleItemActive = async (i: InventoryItem) => {
    await supabase.from('inventory_items').update({ is_active: !i.is_active }).eq('id', i.id)
    toast.success(i.is_active ? 'Item deactivated' : 'Item activated')
    load()
  }
  const toggleConnectionEssential = async (i: InventoryItem) => {
    await supabase.from('inventory_items').update({ is_connection_essential: !i.is_connection_essential }).eq('id', i.id)
    load()
  }
  const toggleServiceActive = async (s: ServiceItem) => {
    await supabase.from('service_items').update({ is_active: !s.is_active }).eq('id', s.id)
    toast.success(s.is_active ? 'Service deactivated' : 'Service activated')
    load()
  }

  const openPurchase = (i: InventoryItem) => {
    setPurchaseFor(i)
    setPurchaseForm({ ...emptyPurchaseForm, unit_cost_at_time: i.unit_cost })
  }
  const savePurchase = async () => {
    if (!purchaseFor || purchaseForm.quantity <= 0) { toast.error('Enter a valid quantity'); return }
    // Routed through the same purchases/purchase_line_items staging + approval
    // gate as the bulk purchase-bill flow on the Transactions page (migration
    // 060) — a quick single-item purchase is still a purchase, and needs the
    // same confirmation before it hits stock/ledger.
    const { data: purchase, error: purchaseErr } = await supabase.from('purchases').insert({
      system: 'water_supply', purchase_date: new Date().toISOString().slice(0, 10),
      method: purchaseForm.method, note: purchaseForm.note || null,
    }).select('id').single()
    if (purchaseErr) { toast.error(friendlyError(purchaseErr)); return }
    const { error: lineErr } = await supabase.from('purchase_line_items').insert({
      purchase_id: purchase.id, inventory_item_id: purchaseFor.id,
      description: purchaseFor.name, quantity: purchaseForm.quantity, unit_cost: purchaseForm.unit_cost_at_time,
    })
    if (lineErr) { toast.error(friendlyError(lineErr)); return }
    const { error: submitErr } = await supabase.rpc('submit_purchase_for_approval', { p_purchase_id: purchase.id })
    if (submitErr) { toast.error(friendlyError(submitErr)); return }
    toast.success(`Purchase of ${purchaseForm.quantity} ${purchaseFor.unit} of ${purchaseFor.name} saved — awaiting approval before it posts to stock`)
    setPurchaseFor(null)
    load()
  }

  const deleteRow = async () => {
    if (!confirmDeleteItem) return
    const { error } = await supabase.from(confirmDeleteItem.table).delete().eq('id', confirmDeleteItem.id)
    if (error) { toast.error(friendlyError(error)); setConfirmDeleteItem(null); return }
    toast.success('Deleted')
    setConfirmDeleteItem(null)
    load()
  }

  const addTemplate = async () => {
    if (!newTemplateName.trim()) { toast.error('Template name required'); return }
    const { error } = await supabase.from('connection_templates').insert({ system: 'water_supply', name: newTemplateName })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Template created')
    setNewTemplateName('')
    setShowAddTemplate(false)
    load()
  }

  const setDefaultTemplate = async (t: ConnectionTemplate) => {
    await supabase.from('connection_templates').update({ is_default: false }).eq('system', 'water_supply').eq('is_default', true)
    await supabase.from('connection_templates').update({ is_default: true }).eq('id', t.id)
    toast.success(`${t.name} set as the default connection bundle`)
    load()
  }

  const addTemplateLine = async (templateId: string) => {
    if (!addLineForm.ref_id) { toast.error('Select an item'); return }
    const payload = {
      template_id: templateId,
      item_type: addLineForm.item_type,
      inventory_item_id: addLineForm.item_type === 'inventory' ? addLineForm.ref_id : null,
      service_item_id: addLineForm.item_type === 'service' ? addLineForm.ref_id : null,
      quantity: addLineForm.quantity,
    }
    const { error } = await supabase.from('connection_template_items').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    setAddLineForm({ item_type: 'inventory', ref_id: '', quantity: 1 })
    load()
  }

  const removeTemplateLine = async (id: string) => {
    await supabase.from('connection_template_items').delete().eq('id', id)
    load()
  }

  const itemName = (id: string | null) => items.find((i) => i.id === id)?.name ?? '—'
  const serviceName = (id: string | null) => services.find((s) => s.id === id)?.name ?? '—'

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{tr('action.loading')}</div>
  if (!access.canWaterSupply) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Inventory &amp; Services belongs to the Water Supply system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <Boxes size={26} /> Inventory &amp; Services
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">Stock items, chargeable services, and connection bundles used when billing consumers.</p>
      </div>

      <div className="flex items-center gap-2 mb-5 border-b border-dp-outline-variant overflow-x-auto admin-scrollbar">
        {(['items', 'services', 'templates', 'movements', 'analytics'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 font-sans text-[14px] font-semibold border-b-2 -mb-px transition-all cursor-pointer flex items-center gap-1.5 shrink-0 whitespace-nowrap ${tab === t ? 'border-dp-secondary text-dp-primary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}
          >
            {t === 'items' && <Boxes size={15} />}
            {t === 'services' && <Wrench size={15} />}
            {t === 'templates' && <Layers size={15} />}
            {t === 'movements' && <History size={15} />}
            {t === 'analytics' && <LineChartIcon size={15} />}
            {t === 'items' ? 'Inventory Items' : t === 'services' ? 'Services' : t === 'templates' ? 'Connection Templates' : t === 'movements' ? 'Stock Movements' : 'Analytics'}
            {t === 'analytics' && lowStockItems.length > 0 && (
              <span className="text-[10px] font-bold bg-dp-error text-white rounded-full px-1.5 py-0.5">{lowStockItems.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'items' && (
        <>
          <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
            <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-2.5">
              <p className="font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">Total Stock Value</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs. {fmt(items.reduce((s, i) => s + i.quantity_on_hand * i.unit_cost, 0))}</p>
              <p className="font-sans text-[11px] text-dp-on-surface-variant">Should match the Inventory Stock account balance on the Trial Balance</p>
            </div>
            <button onClick={() => { setItemForm(emptyItemForm); setShowItemForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <PlusCircle size={15} /> {tr('a.addItem')}
            </button>
          </div>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[850px]">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-4 py-2.5">Code</th>
                    <th className="px-4 py-2.5">{tr('a.name')}</th>
                    <th className="px-4 py-2.5 text-end">Unit Cost</th>
                    <th className="px-4 py-2.5 text-end">Unit Price</th>
                    <th className="px-4 py-2.5 text-end">Stock</th>
                    <th className="px-4 py-2.5">{tr('w.status')}</th>
                    <th className="px-4 py-2.5 text-center">New Connection</th>
                    <th className="px-4 py-2.5 text-end">{tr('a.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{tr('action.loading')}</td></tr>}
                  {!loading && items.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{tr('a.noInventory')}</td></tr>}
                  {!loading && items.map((i) => (
                    <tr key={i.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${!i.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant">{i.item_code}</td>
                      <td className="px-4 py-3 font-semibold">{i.name} <span className="text-dp-on-surface-variant font-normal">({i.unit})</span></td>
                      <td className="px-4 py-3 text-end">{fmt(i.unit_cost)}</td>
                      <td className="px-4 py-3 text-end">{fmt(i.unit_price)}</td>
                      <td className={`px-4 py-3 text-end font-bold ${i.quantity_on_hand <= i.reorder_level ? 'text-dp-error' : ''}`}>{fmt(i.quantity_on_hand)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${i.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{i.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={i.is_connection_essential}
                          onChange={() => toggleConnectionEssential(i)}
                          title="Required equipment for a new connection installation"
                          className="accent-dp-secondary w-4 h-4 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 text-end">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => openPurchase(i)} title="Record Purchase" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><ShoppingCart size={15} /></button>
                          <button onClick={() => toggleItemActive(i)} className="text-[11px] px-2 py-0.5 rounded font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">
                            {i.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button onClick={() => setConfirmDeleteItem({ table: 'inventory_items', id: i.id })} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'services' && (
        <>
          <div className="flex justify-end mb-4">
            <button onClick={() => { setServiceForm(emptyServiceForm); setShowServiceForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <PlusCircle size={15} /> Add Service
            </button>
          </div>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[650px]">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-4 py-2.5">Code</th>
                    <th className="px-4 py-2.5">{tr('a.name')}</th>
                    <th className="px-4 py-2.5 text-end">Charge</th>
                    <th className="px-4 py-2.5">{tr('w.status')}</th>
                    <th className="px-4 py-2.5 text-end">{tr('a.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">{tr('action.loading')}</td></tr>}
                  {!loading && services.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">No services yet.</td></tr>}
                  {!loading && services.map((s) => (
                    <tr key={s.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${!s.is_active ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-[12px] text-dp-on-surface-variant">{s.service_code}</td>
                      <td className="px-4 py-3 font-semibold">{s.name}{s.description && <p className="font-normal text-[12px] text-dp-on-surface-variant">{s.description}</p>}</td>
                      <td className="px-4 py-3 text-end font-bold">{fmt(s.charge_amount)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{s.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td className="px-4 py-3 text-end">
                        <div className="flex items-center justify-end gap-1.5">
                          <button onClick={() => toggleServiceActive(s)} className="text-[11px] px-2 py-0.5 rounded font-sans font-semibold cursor-pointer border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container">
                            {s.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button onClick={() => setConfirmDeleteItem({ table: 'service_items', id: s.id })} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'templates' && (
        <>
          <div className="flex justify-end mb-4">
            <button onClick={() => setShowAddTemplate(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <PlusCircle size={15} /> New Template
            </button>
          </div>
          <div className="space-y-3">
            {templates.length === 0 && !loading && (
              <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center font-sans text-dp-on-surface-variant">No connection templates yet.</div>
            )}
            {templates.map((t) => {
              const lines = templateItems.filter((ti) => ti.template_id === t.id)
              const total = lines.reduce((sum, l) => {
                const price = l.item_type === 'inventory' ? (items.find((i) => i.id === l.inventory_item_id)?.unit_price ?? 0) : (services.find((s) => s.id === l.service_item_id)?.charge_amount ?? 0)
                return sum + price * l.quantity
              }, 0)
              const isOpen = expandedTemplate === t.id
              return (
                <div key={t.id} className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
                  <button onClick={() => setExpandedTemplate(isOpen ? null : t.id)} className="w-full flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-dp-surface-container-low/50 transition-all">
                    <div className="flex items-center gap-2">
                      <span className="font-sans text-[15px] font-bold text-dp-on-surface">{t.name}</span>
                      {t.is_default && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-dp-primary text-white flex items-center gap-1"><Star size={10} /> Default</span>}
                      <span className="font-sans text-[12px] text-dp-on-surface-variant">{lines.length} line{lines.length === 1 ? '' : 's'} · Rs. {fmt(total)} per connection</span>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-dp-outline-variant px-5 py-4 space-y-3">
                      {!t.is_default && (
                        <button onClick={() => setDefaultTemplate(t)} className="text-[12px] font-sans font-semibold text-dp-secondary hover:text-dp-primary cursor-pointer flex items-center gap-1"><Star size={13} /> Set as Default</button>
                      )}
                      {lines.map((l) => (
                        <div key={l.id} className="flex items-center justify-between gap-3 bg-dp-surface-container-low/50 rounded-lg px-3 py-2">
                          <span className="font-sans text-[13.5px]">
                            {l.item_type === 'inventory' ? itemName(l.inventory_item_id) : serviceName(l.service_item_id)}
                            <span className="text-dp-on-surface-variant"> × {l.quantity}</span>
                          </span>
                          <button onClick={() => removeTemplateLine(l.id)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={14} /></button>
                        </div>
                      ))}
                      <div className="flex items-end gap-2 pt-2 border-t border-dp-outline-variant">
                        <select value={addLineForm.item_type} onChange={(e) => setAddLineForm({ ...addLineForm, item_type: e.target.value as 'inventory' | 'service', ref_id: '' })} className="input-field !py-2">
                          <option value="inventory">Inventory</option>
                          <option value="service">Service</option>
                        </select>
                        <select value={addLineForm.ref_id} onChange={(e) => setAddLineForm({ ...addLineForm, ref_id: e.target.value })} className="input-field !py-2">
                          <option value="">{tr('a.select')}</option>
                          {(addLineForm.item_type === 'inventory' ? items : services).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                        <input type="number" min={1} value={addLineForm.quantity || ''} onChange={(e) => setAddLineForm({ ...addLineForm, quantity: +e.target.value })} className="input-field !py-2 w-20" placeholder="Qty" />
                        <button onClick={() => addTemplateLine(t.id)} className="px-3 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">Add</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}

      {tab === 'movements' && (
        <>
          <div className="flex justify-end mb-4">
            <select value={movementItemFilter} onChange={(e) => setMovementItemFilter(e.target.value)} className="input-field !py-2 max-w-xs">
              <option value="">All items</option>
              {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-start min-w-[650px]">
                <thead>
                  <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                    <th className="px-4 py-2.5">{tr('w.date')}</th>
                    <th className="px-4 py-2.5">Item</th>
                    <th className="px-4 py-2.5">{tr('a.type')}</th>
                    <th className="px-4 py-2.5 text-end">Qty</th>
                    <th className="px-4 py-2.5 text-end">Cost/Unit</th>
                    <th className="px-4 py-2.5 text-end">Value</th>
                    <th className="px-4 py-2.5">{tr('a.note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const filtered = movementItemFilter ? movements.filter((m) => m.item_id === movementItemFilter) : movements
                    if (filtered.length === 0) return <tr><td colSpan={7} className="px-4 py-8 text-center text-dp-on-surface-variant font-sans">No stock movements yet.</td></tr>
                    return filtered.map((m) => {
                      const item = items.find((i) => i.id === m.item_id)
                      const cost = m.unit_cost_at_time ?? item?.unit_cost ?? 0
                      const typeStyle = m.txn_type === 'purchase' ? 'text-emerald-700' : m.txn_type === 'usage' ? 'text-dp-error' : 'text-dp-on-surface-variant'
                      return (
                        <tr key={m.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                          <td className="px-4 py-3 whitespace-nowrap">{new Date(m.txn_date).toLocaleDateString('en-GB')}</td>
                          <td className="px-4 py-3 font-semibold">{item?.name ?? '—'}</td>
                          <td className={`px-4 py-3 font-semibold capitalize ${typeStyle}`}>{m.txn_type}</td>
                          <td className="px-4 py-3 text-end">{m.quantity > 0 ? '+' : ''}{fmt(m.quantity)}</td>
                          <td className="px-4 py-3 text-end">{fmt(cost)}</td>
                          <td className="px-4 py-3 text-end font-semibold">{fmt(Math.abs(m.quantity) * cost)}</td>
                          <td className="px-4 py-3 text-dp-on-surface-variant">{m.note ?? '—'}</td>
                        </tr>
                      )
                    })
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'analytics' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg border border-dp-outline-variant p-5">
            <h3 className="font-sans text-[15px] font-bold text-dp-on-surface mb-1 flex items-center gap-2"><LineChartIcon size={16} className="text-dp-secondary" /> Stock Value Trend — Last 6 Months</h3>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">Reconstructed from the Inventory Stock ledger account balance at each month end.</p>
            {analyticsLoading ? (
              <div className="h-[220px] flex items-center justify-center font-sans text-[13px] text-dp-on-surface-variant">{tr('action.loading')}</div>
            ) : (
              <StockValueTrendChart data={stockTrend} />
            )}
          </div>

          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="px-5 py-3.5 border-b border-dp-outline-variant bg-amber-50 flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-700" />
              <span className="font-sans text-[14px] font-bold text-amber-900">Low Stock ({lowStockItems.length})</span>
            </div>
            {lowStockItems.length === 0 ? (
              <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">No items at or below their reorder level.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start min-w-[500px]">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-5 py-2.5">Item</th>
                      <th className="px-5 py-2.5 text-end">In Stock</th>
                      <th className="px-5 py-2.5 text-end">Reorder Level</th>
                      <th className="px-5 py-2.5 text-end">{tr('w.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStockItems.map((i) => (
                      <tr key={i.id} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                        <td className="px-5 py-3 font-semibold">{i.name} <span className="text-dp-on-surface-variant font-normal">({i.item_code})</span></td>
                        <td className="px-5 py-3 text-end font-bold text-dp-error">{fmt(i.quantity_on_hand)} {i.unit}</td>
                        <td className="px-5 py-3 text-end text-dp-on-surface-variant">{fmt(i.reorder_level)} {i.unit}</td>
                        <td className="px-5 py-3 text-end">
                          <button onClick={() => openPurchase(i)} className="flex items-center gap-1.5 ms-auto px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                            <ShoppingCart size={13} /> Purchase
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="px-5 py-3.5 border-b border-dp-outline-variant bg-dp-surface-container-low/60 flex items-center justify-between flex-wrap gap-2">
              <span className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-2"><Trophy size={16} className="text-amber-600" /> Top Selling Inventory</span>
              <div className="flex items-center gap-1 bg-white border border-dp-outline-variant rounded-lg p-1">
                {(['month', '90d', 'all'] as TopSellingPeriod[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setTopSellingPeriod(p)}
                    className={`px-2.5 py-1 rounded-md font-sans text-[12px] font-semibold cursor-pointer transition-all ${topSellingPeriod === p ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant hover:bg-dp-surface-container-low'}`}
                  >
                    {p === 'month' ? 'This Month' : p === '90d' ? 'Last 90 Days' : 'All Time'}
                  </button>
                ))}
              </div>
            </div>
            {analyticsLoading ? (
              <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">{tr('action.loading')}</p>
            ) : topSelling.length === 0 ? (
              <p className="px-5 py-6 text-center font-sans text-[13.5px] text-dp-on-surface-variant">No inventory sales in this period yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start min-w-[550px]">
                  <thead>
                    <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                      <th className="px-5 py-2.5">#</th>
                      <th className="px-5 py-2.5">Item</th>
                      <th className="px-5 py-2.5 text-end">Qty Sold</th>
                      <th className="px-5 py-2.5 text-end">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSelling.map((t, idx) => (
                      <tr key={t.itemId} className="font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0">
                        <td className="px-5 py-3 text-dp-on-surface-variant">{idx + 1}</td>
                        <td className="px-5 py-3 font-semibold">{t.name} <span className="text-dp-on-surface-variant font-normal">({t.itemCode})</span></td>
                        <td className="px-5 py-3 text-end">{fmt(t.quantitySold)}</td>
                        <td className="px-5 py-3 text-end font-bold text-dp-primary">Rs. {fmt(t.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteItem}
        title="Delete"
        message="This cannot be undone."
        onConfirm={deleteRow}
        onCancel={() => setConfirmDeleteItem(null)}
      />

      {showItemForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowItemForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">Add Inventory Item</h2>
              <button onClick={() => setShowItemForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.name')}</label>
                <input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} className="input-field" placeholder="e.g. Water Meter" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Unit</label>
                <input value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} className="input-field" placeholder="piece, meter, etc." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Unit Cost</label>
                  <input type="number" value={itemForm.unit_cost || ''} onChange={(e) => setItemForm({ ...itemForm, unit_cost: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Unit Price</label>
                  <input type="number" value={itemForm.unit_price || ''} onChange={(e) => setItemForm({ ...itemForm, unit_price: +e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Reorder Level (optional)</label>
                <input type="number" value={itemForm.reorder_level || ''} onChange={(e) => setItemForm({ ...itemForm, reorder_level: +e.target.value })} className="input-field" />
              </div>
              <button onClick={saveItem} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> Save Item
              </button>
            </div>
          </div>
        </div>
      )}

      {showServiceForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowServiceForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">Add Service</h2>
              <button onClick={() => setShowServiceForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.name')}</label>
                <input value={serviceForm.name} onChange={(e) => setServiceForm({ ...serviceForm, name: e.target.value })} className="input-field" placeholder="e.g. New Connection Installation" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Charge Amount</label>
                <input type="number" value={serviceForm.charge_amount || ''} onChange={(e) => setServiceForm({ ...serviceForm, charge_amount: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.descriptionOptional')}</label>
                <input value={serviceForm.description} onChange={(e) => setServiceForm({ ...serviceForm, description: e.target.value })} className="input-field" />
              </div>
              <button onClick={saveService} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> Save Service
              </button>
            </div>
          </div>
        </div>
      )}

      {purchaseFor && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPurchaseFor(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">Record Purchase</h2>
              <button onClick={() => setPurchaseFor(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{purchaseFor.name} · Current stock: {fmt(purchaseFor.quantity_on_hand)} {purchaseFor.unit}</p>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.quantity')}</label>
                  <input type="number" value={purchaseForm.quantity || ''} onChange={(e) => setPurchaseForm({ ...purchaseForm, quantity: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Unit Cost</label>
                  <input type="number" value={purchaseForm.unit_cost_at_time || ''} onChange={(e) => setPurchaseForm({ ...purchaseForm, unit_cost_at_time: +e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Paid Via</label>
                <select value={purchaseForm.method} onChange={(e) => setPurchaseForm({ ...purchaseForm, method: e.target.value })} className="input-field">
                  <option value="cash">{tr('w.cash')}</option>
                  <option value="bank">{tr('a.bank')}</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.noteOptional')}</label>
                <input value={purchaseForm.note} onChange={(e) => setPurchaseForm({ ...purchaseForm, note: e.target.value })} className="input-field" />
              </div>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant">Total: Rs. {fmt(purchaseForm.quantity * purchaseForm.unit_cost_at_time)}</p>
              <button onClick={savePurchase} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <ShoppingCart size={16} /> Record Purchase
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddTemplate && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAddTemplate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">New Connection Template</h2>
              <button onClick={() => setShowAddTemplate(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{tr('a.name')}</label>
                <input value={newTemplateName} onChange={(e) => setNewTemplateName(e.target.value)} className="input-field" placeholder="e.g. Commercial Connection" />
              </div>
              <button onClick={addTemplate} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Save size={16} /> Create
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
