'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  PlusCircle, Search, X, ChevronLeft, Plus, Pencil, Trash2, Eye, Banknote,
  UserPlus, Printer, CheckCircle2, Clock, Wrench, RefreshCw, Lock, Unlock,
} from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { fetchBrandingSettings, type BrandingSettings } from '@/lib/branding'
import { nodeToPdfBlob, printBlob } from '@/lib/receiptExport'
import { renderTemplate } from '@/lib/messageTemplates'
import { findDuplicate, type DuplicateCandidate } from '@/lib/duplicateCheck'

interface ConnectionRequest {
  id: string; request_number: string | null; status: 'draft' | 'pending_payment' | 'processing' | 'installed'
  consumer_name: string; consumer_phone: string; consumer_address: string | null
  father_husband_name: string | null; whatsapp_number: string | null; whatsapp_same_as_mobile: boolean
  house_no: string | null; area: string | null; connections: number
  sector: string | null; requested_date: string; description: string | null
  wants_inventory_from_us: boolean
  plumber_charge: number; digging_charge: number; security_deposit_amount: number
  total_amount: number
  bill_id: string | null; payment_id: string | null; consumer_id: string | null
  recurring_schedule_id: string | null
  task_status: 'unassigned' | 'assigned' | 'in_progress' | 'done'
  created_at: string
}
interface RequestItemRow { inventory_item_id: string; quantity: number; unit_price: number; description?: string }
interface InventoryItemOpt { id: string; name: string; unit: string; unit_price: number; quantity_on_hand: number; is_connection_essential: boolean }
interface Sector { id: string; name: string }
interface Account { id: string; code: string; name: string; type: string }

const today = () => new Date().toISOString().slice(0, 10)

const emptyForm = {
  consumer_name: '', consumer_phone: '', consumer_address: '',
  father_husband_name: '', whatsapp_number: '', whatsapp_same_as_mobile: true,
  house_no: '', area: '', connections: 1, sector: '',
  description: '', wants_inventory_from_us: false,
  plumber_charge: 0, digging_charge: 0, security_deposit_amount: 0,
}

const statusLabels: Record<ConnectionRequest['status'], string> = {
  draft: 'Draft', pending_payment: 'Pending Payment', processing: 'Processing', installed: 'Activated',
}
const statusStyles: Record<ConnectionRequest['status'], string> = {
  draft: 'bg-gray-100 text-gray-700',
  pending_payment: 'bg-amber-100 text-amber-800',
  processing: 'bg-blue-100 text-blue-800',
  installed: 'bg-emerald-100 text-emerald-800',
}

const taskStageLabels: Record<ConnectionRequest['task_status'], string> = {
  unassigned: 'Unassigned', assigned: 'Assigned', in_progress: 'In Progress', done: 'Done',
}

function fmtAmount(n: number) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function normalizePakPhoneLocal(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  return digits
}

export default function ConnectionsPage() {
  const supabase = createClient()
  const [requests, setRequests] = useState<ConnectionRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [inventoryItems, setInventoryItems] = useState<InventoryItemOpt[]>([])
  const [sectors, setSectors] = useState<Sector[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [branding, setBranding] = useState<BrandingSettings | null>(null)
  const [messageTemplates, setMessageTemplates] = useState<Record<string, string>>({})

  const [showForm, setShowForm] = useState(false)
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [items, setItems] = useState<RequestItemRow[]>([])
  const [saving, setSaving] = useState(false)

  const [itemModalStep, setItemModalStep] = useState<'closed' | 'picker' | 'detail'>('closed')
  const [catalogSearch, setCatalogSearch] = useState('')
  const [newItemLine, setNewItemLine] = useState({ itemId: '', quantity: 1, unit_price: 0 })
  const [editingItemIndex, setEditingItemIndex] = useState<number | null>(null)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const challanRef = useRef<HTMLDivElement>(null)

  const [cashReceiveTarget, setCashReceiveTarget] = useState<ConnectionRequest | null>(null)
  const [receivingCash, setReceivingCash] = useState(false)

  const [activationTarget, setActivationTarget] = useState<ConnectionRequest | null>(null)
  // Profile fields (name, father's name, address, etc.) are captured once at
  // request time — this step is only about turning on recurring billing, not
  // re-collecting the account. father_husband_name is shown, not editable.
  const [activationForm, setActivationForm] = useState({
    father_husband_name: '', whatsapp_number: '',
    discount_amount: 0, description: '', recurring_enabled: true, monthly_amount: 0,
  })
  const [activating, setActivating] = useState(false)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  // Committee-set fixed defaults (Settings > New Connection Charges) — pre-
  // fill a brand-new request with these, but the accountant can still raise
  // them per job; the public website application never sees these at all
  // (it doesn't create a connection_requests row, so there's nothing there to lock down).
  const [chargeDefaults, setChargeDefaults] = useState({ plumber_charge: 0, digging_charge: 0, security_deposit_amount: 0 })
  // Locked by default (both for a brand-new request and when editing an
  // existing one) — the accountant has to deliberately unlock before these
  // fixed charges can be changed, rather than them just sitting as freely
  // editable number fields.
  const [chargesLocked, setChargesLocked] = useState(true)
  const [consumerIdentities, setConsumerIdentities] = useState<DuplicateCandidate[]>([])

  const load = async () => {
    const [reqRes, invRes, sectorRes, acctRes, settingsRes, consumersRes] = await Promise.all([
      supabase.from('connection_requests').select('*').order('created_at', { ascending: false }),
      supabase.from('inventory_items').select('id, name, unit, unit_price, quantity_on_hand, is_connection_essential').eq('system', 'water_supply').eq('is_active', true).order('name'),
      supabase.from('sectors').select('id, name').order('display_order').order('name'),
      supabase.from('accounts').select('id, code, name, type').eq('system', 'water_supply').eq('is_active', true),
      supabase.from('site_settings').select('key, value').in('key', ['connection_plumber_charge', 'connection_digging_charge', 'connection_security_deposit']),
      supabase.from('consumers').select('consumer_id, name, father_husband_name, mobile, whatsapp_number'),
    ])
    setRequests(reqRes.data ?? [])
    setInventoryItems(invRes.data ?? [])
    setSectors(sectorRes.data ?? [])
    setAccounts(acctRes.data ?? [])
    setConsumerIdentities((consumersRes.data ?? []).map((c) => ({
      id: c.consumer_id, name: c.name, father_husband_name: c.father_husband_name, mobile: c.mobile, whatsapp_number: c.whatsapp_number,
    })))
    const settingsMap = Object.fromEntries((settingsRes.data ?? []).map((s) => [s.key, s.value]))
    setChargeDefaults({
      plumber_charge: Number(settingsMap.connection_plumber_charge) || 0,
      digging_charge: Number(settingsMap.connection_digging_charge) || 0,
      security_deposit_amount: Number(settingsMap.connection_security_deposit) || 0,
    })
    setLoading(false)
  }

  useEffect(() => {
    load()
    fetchBrandingSettings().then(setBranding)
    supabase.from('message_templates').select('key, body').then(({ data }) => {
      setMessageTemplates(Object.fromEntries((data ?? []).map((t) => [t.key, t.body])))
    })
    // Task status (e.g. marked Done by an incharge on a different device/tab)
    // updates elsewhere with no realtime push to this page — refresh whenever
    // this tab regains focus so the badge doesn't sit stale.
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const refetchCatalog = async () => {
    const { data } = await supabase.from('inventory_items').select('id, name, unit, unit_price, quantity_on_hand, is_connection_essential').eq('system', 'water_supply').eq('is_active', true).order('name')
    setInventoryItems(data ?? [])
  }

  // The equipment checklist a new connection needs is whatever's checked
  // "New Connection" on the Inventory page — not a manual pick from the full
  // catalog. Shown on every request as an informational checklist regardless
  // of who ends up supplying it.
  const essentialItems: RequestItemRow[] = inventoryItems
    .filter((i) => i.is_connection_essential)
    .map((i) => ({ inventory_item_id: i.id, quantity: 1, unit_price: i.unit_price, description: i.name }))

  // Only priced/billed when the consumer is buying from us — otherwise the
  // list is a pure informational checklist with no financial impact.
  const isLineAvailable = (l: RequestItemRow) => {
    const inv = inventoryItems.find((i) => i.id === l.inventory_item_id)
    return !!inv && inv.quantity_on_hand >= l.quantity
  }
  const itemsTotal = form.wants_inventory_from_us
    ? items.reduce((s, l) => s + (isLineAvailable(l) ? l.quantity * l.unit_price : 0), 0)
    : 0
  const total = itemsTotal + (form.plumber_charge || 0) + (form.digging_charge || 0) + (form.security_deposit_amount || 0)

  const resetForm = () => { setForm(emptyForm); setItems([]); setEditingRequestId(null); setChargesLocked(true) }
  const openNewRequest = () => {
    resetForm()
    setForm((f) => ({ ...f, ...chargeDefaults }))
    setItems(essentialItems.map((l) => ({ ...l })))
    setShowForm(true)
  }

  const formFromRequest = (r: ConnectionRequest) => ({
    consumer_name: r.consumer_name, consumer_phone: r.consumer_phone, consumer_address: r.consumer_address || '',
    father_husband_name: r.father_husband_name || '', whatsapp_number: r.whatsapp_number || '',
    whatsapp_same_as_mobile: r.whatsapp_same_as_mobile, house_no: r.house_no || '', area: r.area || '',
    connections: r.connections || 1, sector: r.sector || '', description: r.description || '',
    wants_inventory_from_us: r.wants_inventory_from_us,
    plumber_charge: r.plumber_charge, digging_charge: r.digging_charge, security_deposit_amount: r.security_deposit_amount,
  })

  const openEditRequest = async (r: ConnectionRequest) => {
    setForm(formFromRequest(r))
    setChargesLocked(true)
    const { data } = await supabase.from('connection_request_items').select('inventory_item_id, quantity, unit_price').eq('request_id', r.id)
    setItems((data ?? []).map((d) => ({ ...d, description: inventoryItems.find((i) => i.id === d.inventory_item_id)?.name })))
    setEditingRequestId(r.id)
    setShowForm(true)
  }

  // Preview/print a request's challan straight from the list, at any status —
  // not just while its form happens to be open. Loads the same form/items
  // state the challan template already reads, just without opening the
  // editable form modal behind it.
  const openPreview = async (r: ConnectionRequest) => {
    setForm(formFromRequest(r))
    const { data } = await supabase.from('connection_request_items').select('inventory_item_id, quantity, unit_price').eq('request_id', r.id)
    setItems((data ?? []).map((d) => ({ ...d, description: inventoryItems.find((i) => i.id === d.inventory_item_id)?.name })))
    setPreviewOpen(true)
  }

  // Add-item picker/detail flow — identical pattern to the Add Item/Service
  // modal already built for Generate Bill.
  const selectCatalogItem = (id: string) => {
    const item = inventoryItems.find((i) => i.id === id)
    if (!item) return
    setNewItemLine({ itemId: id, quantity: 1, unit_price: item.unit_price })
    setEditingItemIndex(null)
    setItemModalStep('detail')
  }
  const openEditItemLine = (idx: number) => {
    const l = items[idx]
    setNewItemLine({ itemId: l.inventory_item_id, quantity: l.quantity, unit_price: l.unit_price })
    setEditingItemIndex(idx)
    setItemModalStep('detail')
  }
  const saveItemLine = (): boolean => {
    const item = inventoryItems.find((i) => i.id === newItemLine.itemId)
    if (!item) { toast.error('Choose an item'); return false }
    if (!newItemLine.quantity || newItemLine.quantity <= 0) { toast.error('Enter a valid quantity'); return false }
    const isDuplicate = items.some((l, i) => (editingItemIndex === null || i !== editingItemIndex) && l.inventory_item_id === item.id)
    if (isDuplicate) { toast.error(`${item.name} is already on this request — edit that line instead`); return false }
    const line: RequestItemRow = { inventory_item_id: item.id, description: item.name, quantity: newItemLine.quantity, unit_price: newItemLine.unit_price || item.unit_price }
    if (editingItemIndex !== null) setItems(items.map((l, i) => (i === editingItemIndex ? line : l)))
    else setItems([...items, line])
    setEditingItemIndex(null)
    return true
  }
  const saveItemAndClose = () => { if (saveItemLine()) setItemModalStep('closed') }
  const saveItemAndNew = () => { if (saveItemLine()) { setCatalogSearch(''); setItemModalStep('picker') } }
  const removeItemLine = (idx: number) => setItems(items.filter((_, i) => i !== idx))

  const confirmRequest = async () => {
    if (!form.consumer_name.trim()) { toast.error('Consumer name is required'); return }
    if (!form.consumer_phone.trim()) { toast.error('Consumer phone is required'); return }

    const whatsapp = form.whatsapp_same_as_mobile ? form.consumer_phone : form.whatsapp_number
    const requestIdentities: DuplicateCandidate[] = requests
      .filter((r) => !r.consumer_id) // already-converted ones are covered by consumerIdentities instead
      .map((r) => ({ id: r.id, name: r.consumer_name, father_husband_name: r.father_husband_name, mobile: r.consumer_phone, whatsapp_number: r.whatsapp_number }))
    const duplicate = findDuplicate(
      { name: form.consumer_name, father_husband_name: form.father_husband_name, mobile: form.consumer_phone, whatsapp_number: whatsapp },
      [...consumerIdentities, ...requestIdentities],
      editingRequestId ?? undefined
    )
    if (duplicate) { toast.error(duplicate); return }

    setSaving(true)
    const payload = { ...form, sector: form.sector || null, total_amount: total }

    if (editingRequestId) {
      const { error } = await supabase.from('connection_requests').update(payload).eq('id', editingRequestId)
      if (error) { toast.error(friendlyError(error)); setSaving(false); return }
      await supabase.from('connection_request_items').delete().eq('request_id', editingRequestId)
      for (const l of items) {
        const { error: itemErr } = await supabase.from('connection_request_items').insert({ request_id: editingRequestId, inventory_item_id: l.inventory_item_id, quantity: l.quantity, unit_price: l.unit_price })
        if (itemErr) toast.error(friendlyError(itemErr))
      }
      toast.success('Connection request updated')
    } else {
      const { data: req, error } = await supabase.from('connection_requests').insert(payload).select('id, request_number').single()
      if (error) { toast.error(friendlyError(error)); setSaving(false); return }
      for (const l of items) {
        const { error: itemErr } = await supabase.from('connection_request_items').insert({ request_id: req.id, inventory_item_id: l.inventory_item_id, quantity: l.quantity, unit_price: l.unit_price })
        if (itemErr) toast.error(friendlyError(itemErr))
      }
      toast.success(`Connection request ${req.request_number} saved`)
    }
    setSaving(false)
    setShowForm(false)
    setPreviewOpen(false)
    resetForm()
    load()
  }

  const printChallan = async () => {
    if (!challanRef.current) return
    setPrinting(true)
    try {
      const blob = await nodeToPdfBlob(challanRef.current)
      printBlob(blob)
    } finally {
      setPrinting(false)
    }
  }

  // Cash Receive — replays the exact insert sequence Generate Bill's saveBill()
  // already uses (consumer -> bill -> bill_line_items -> security deposit
  // voucher -> payment), so inventory deduction, weighted-average COGS, and
  // all ledger postings happen automatically via the existing triggers.
  const doCashReceive = async () => {
    if (!cashReceiveTarget) return
    const r = cashReceiveTarget
    setReceivingCash(true)

    let consumerId = r.consumer_id
    if (!consumerId) {
      const { data: consumer, error: consErr } = await supabase.from('consumers').insert({
        name: r.consumer_name, father_husband_name: r.father_husband_name, mobile: r.consumer_phone,
        whatsapp_number: r.whatsapp_same_as_mobile ? r.consumer_phone : r.whatsapp_number,
        whatsapp_same_as_mobile: r.whatsapp_same_as_mobile,
        house_no: r.house_no, area: r.area, address: r.consumer_address, sector: r.sector,
        connections: r.connections || 1, status: 'active',
      }).select('consumer_id').single()
      if (consErr) { toast.error(`Could not create consumer: ${consErr.message}`); setReceivingCash(false); return }
      consumerId = consumer.consumer_id
    }

    const now = new Date()
    const dueDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-07`
    const { data: bill, error: billErr } = await supabase.from('bills').insert({
      consumer_id: consumerId, month: now.getMonth() + 1, year: now.getFullYear(), amount_pkr: 0, due_date: dueDate,
      description: `New Connection Installation (equipment & charges, not a monthly water bill) — ${r.request_number}${r.description ? ' — ' + r.description : ''}`,
    }).select('id, bill_number').single()
    if (billErr) { toast.error(`Could not create bill: ${billErr.message}`); setReceivingCash(false); return }

    // Equipment lines only turn into a real sale/stock deduction when the consumer
    // chose to buy from us — otherwise the checklist was informational only and
    // was never meant to touch stock or the bill.
    if (r.wants_inventory_from_us) {
      const { data: reqItems } = await supabase.from('connection_request_items').select('inventory_item_id, quantity, unit_price').eq('request_id', r.id)
      const skipped: string[] = []
      for (const it of (reqItems ?? [])) {
        const item = inventoryItems.find((i) => i.id === it.inventory_item_id)
        if (!item || item.quantity_on_hand < it.quantity) { skipped.push(item?.name ?? 'Item'); continue }
        const { error: lineErr } = await supabase.from('bill_line_items').insert({
          bill_id: bill.id, item_type: 'inventory', inventory_item_id: it.inventory_item_id,
          description: item.name, quantity: it.quantity, unit_price: it.unit_price,
        })
        if (lineErr) toast.error(`${item.name}: ${lineErr.message}`)
      }
      if (skipped.length > 0) toast.error(`Not enough stock for: ${skipped.join(', ')} — bill these separately once restocked.`)
    }
    if (r.plumber_charge > 0) {
      const plumberAcct = accounts.find((a) => a.code === 'WS-2004')
      await supabase.from('bill_line_items').insert({ bill_id: bill.id, item_type: 'other_charge', charge_account_id: plumberAcct?.id, description: 'Plumber Charge', quantity: 1, unit_price: r.plumber_charge })
    }
    if (r.digging_charge > 0) {
      const diggingAcct = accounts.find((a) => a.code === 'WS-2005')
      await supabase.from('bill_line_items').insert({ bill_id: bill.id, item_type: 'other_charge', charge_account_id: diggingAcct?.id, description: 'Digging Charge', quantity: 1, unit_price: r.digging_charge })
    }

    // Payment is inserted before the security deposit so both can share the same
    // receipt number — to the accountant this is one cash-collection moment (one
    // Cash Receipt), not two. The deposit still posts to its own liability
    // account behind the scenes (it's refundable, never income), but its
    // receipt_no is explicitly passed through so the trigger that would
    // otherwise mint a fresh number just reuses this one instead (it only
    // assigns a new one when receipt_no is still NULL).
    const { data: billRow } = await supabase.from('bills').select('amount_pkr').eq('id', bill.id).single()
    const paymentAmount = billRow?.amount_pkr ?? 0
    let paymentId: string | null = null
    let sharedReceiptNo: string | null = null
    if (paymentAmount > 0) {
      const { data: pay, error: payErr } = await supabase.from('payments').insert({
        bill_id: bill.id, consumer_id: consumerId, amount_pkr: paymentAmount, method: 'cash',
      }).select('id, receipt_no').single()
      if (payErr) toast.error(`Payment could not be recorded: ${payErr.message}`)
      else { paymentId = pay.id; sharedReceiptNo = pay.receipt_no }
    }

    if (r.security_deposit_amount > 0) {
      const depositAcct = accounts.find((a) => a.code === 'WS-5002')
      const cashAcct = accounts.find((a) => a.code === 'WS-1001')
      if (depositAcct && cashAcct) {
        const { data: voucher, error: vErr } = await supabase.from('vouchers').insert({
          system: 'water_supply', voucher_type: 'security_deposit', voucher_date: today(),
          particular: `Security deposit — ${r.consumer_name} — Bill ${bill.bill_number}`, amount_pkr: r.security_deposit_amount,
          bill_id: bill.id, from_account_id: depositAcct.id, to_account_id: cashAcct.id,
          receipt_no: sharedReceiptNo,
        }).select('id').single()
        if (vErr) toast.error(`Security deposit could not be recorded: ${vErr.message}`)
        else await supabase.from('bills').update({ security_deposit_voucher_id: voucher.id, security_deposit_amount: r.security_deposit_amount }).eq('id', bill.id)
      }
    }

    await supabase.from('connection_requests').update({
      status: 'processing', bill_id: bill.id, payment_id: paymentId, consumer_id: consumerId,
    }).eq('id', r.id)

    setReceivingCash(false)
    setCashReceiveTarget(null)
    toast.success(`Cash received — Bill ${bill.bill_number} generated`)
    load()
  }

  const openActivation = async (r: ConnectionRequest) => {
    setActivationTarget(r)
    setActivationForm({
      father_husband_name: '', whatsapp_number: r.consumer_phone || '',
      discount_amount: 0, description: r.description || '', recurring_enabled: true, monthly_amount: 0,
    })
    if (r.consumer_id) {
      const { data: consumer } = await supabase.from('consumers')
        .select('monthly_rate, father_husband_name, whatsapp_number')
        .eq('consumer_id', r.consumer_id).single()
      if (consumer) setActivationForm((f) => ({
        ...f, monthly_amount: consumer.monthly_rate,
        father_husband_name: consumer.father_husband_name || '',
        whatsapp_number: consumer.whatsapp_number || r.consumer_phone || '',
      }))
    }
  }

  const doActivate = async () => {
    if (!activationTarget?.consumer_id) return
    if (!activationForm.whatsapp_number.trim()) { toast.error('A WhatsApp number is required to send the activation message'); return }
    const r = activationTarget
    setActivating(true)

    await supabase.from('consumers').update({
      whatsapp_number: activationForm.whatsapp_number, whatsapp_same_as_mobile: activationForm.whatsapp_number === r.consumer_phone,
    }).eq('consumer_id', r.consumer_id)

    let recurringScheduleId: string | null = null
    const netAmount = Math.max(activationForm.monthly_amount - activationForm.discount_amount, 0)
    if (activationForm.recurring_enabled && activationForm.monthly_amount > 0) {
      const next = new Date()
      next.setMonth(next.getMonth() + 1)
      // Gross amount + discount_amount kept separate (not pre-netted) so the
      // generated bill posts the discount as its own ledger leg, same as any
      // manually-generated bill (migration 067) — and so it still counts
      // toward the Billing page's "With Discount" filter.
      const { data: sched, error: schedErr } = await supabase.from('recurring_schedules').insert({
        system: 'water_supply', schedule_type: 'bill', frequency: 'monthly',
        next_run_date: next.toISOString(), consumer_id: r.consumer_id,
        amount_pkr: activationForm.monthly_amount, discount_amount: activationForm.discount_amount || 0,
        particular: activationForm.description || null,
      }).select('id').single()
      if (schedErr) toast.error(schedErr.code === '23505' ? 'This consumer already has an active recurring bill' : `Recurring schedule could not be created: ${schedErr.message}`)
      else recurringScheduleId = sched.id
    }

    await supabase.from('connection_requests').update({
      status: 'installed', recurring_schedule_id: recurringScheduleId,
    }).eq('id', r.id)

    const intl = normalizePakPhoneLocal(activationForm.whatsapp_number)
    if (intl) {
      const template = messageTemplates.connection_activated
        ?? '*Dhab Pari Water Committee*\n\nCongratulations %%name%%! Your new water connection (%%consumer_id%%) has been installed and activated. Monthly bill: Rs. %%monthly_amount%%.\n\nThank you for connecting with us.'
      const msg = encodeURIComponent(renderTemplate(template, {
        name: r.consumer_name, consumer_id: r.consumer_id ?? '', monthly_amount: fmtAmount(netAmount),
      }))
      window.open(`https://wa.me/${intl}?text=${msg}`, '_blank')
    }

    setActivating(false)
    setActivationTarget(null)
    toast.success('Connection activated')
    load()
  }

  const deleteRequest = async () => {
    if (!confirmDeleteId) return
    const { error } = await supabase.from('connection_requests').delete().eq('id', confirmDeleteId)
    if (error) toast.error(friendlyError(error))
    else { toast.success('Request deleted'); load() }
    setConfirmDeleteId(null)
  }

  const activeItem = inventoryItems.find((i) => i.id === newItemLine.itemId)
  const itemTotal = (newItemLine.quantity || 0) * (newItemLine.unit_price || 0)

  return (
    <div className="txn-form">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="font-heading text-[26px] sm:text-[32px] font-bold text-dp-primary flex items-center gap-2.5">
          <UserPlus size={28} /> New Connections
        </h1>
        <div className="flex items-center gap-2">
          <button onClick={load} title="Refresh" className="p-2.5 border border-dp-outline-variant rounded-lg text-dp-on-surface-variant hover:bg-dp-surface-container-low cursor-pointer transition-all">
            <RefreshCw size={16} />
          </button>
          <button onClick={openNewRequest} className="flex items-center gap-2 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
            <PlusCircle size={16} /> New Connection Request
          </button>
        </div>
      </div>

      {loading ? (
        <p className="font-sans text-dp-on-surface-variant py-8 text-center">Loading...</p>
      ) : requests.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">No connection requests yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden divide-y divide-dp-outline-variant">
          {requests.map((r) => {
            return (
              <div key={r.id} className="p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-sans text-[14.5px] font-bold text-dp-on-surface">{r.consumer_name}</p>
                    <button
                      onClick={() => r.status === 'processing' && r.task_status === 'done' && openActivation(r)}
                      className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${r.status === 'processing' && r.task_status === 'done' ? 'bg-emerald-100 text-emerald-800 cursor-pointer hover:opacity-80' : statusStyles[r.status]}`}
                      title={r.status === 'processing' ? (r.task_status === 'done' ? 'Click to activate this connection' : 'Installation task must be marked Done on Task Todo before activating') : undefined}
                    >
                      {r.status === 'processing'
                        ? (r.task_status === 'done' ? 'Activate Account Now' : `Processing · ${taskStageLabels[r.task_status]}`)
                        : statusLabels[r.status]}
                    </button>
                  </div>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                    {r.request_number} · {r.consumer_phone} · {new Date(r.requested_date).toLocaleDateString('en-GB')}
                    {r.description ? ` · ${r.description}` : ''}
                  </p>
                </div>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface shrink-0">Rs. {fmtAmount(r.total_amount)}</p>
                <div className="flex items-center gap-1 shrink-0">
                  {r.status === 'pending_payment' && (
                    <button onClick={() => setCashReceiveTarget(r)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                      <Banknote size={13} /> Cash Receive
                    </button>
                  )}
                  <button onClick={() => openPreview(r)} title="Preview / Print Challan" className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Eye size={15} /></button>
                  {(r.status === 'draft' || r.status === 'pending_payment') && (
                    <button onClick={() => openEditRequest(r)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={15} /></button>
                  )}
                  {(r.status === 'draft' || r.status === 'pending_payment') && (
                    <button onClick={() => setConfirmDeleteId(r.id)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={15} /></button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ---------------- Request form ---------------- */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-2xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant shrink-0">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">{editingRequestId ? 'Edit Connection Request' : 'New Connection Request'}</h2>
              <button onClick={() => setShowForm(false)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Consumer Name</label>
                  <input value={form.consumer_name} onChange={(e) => setForm({ ...form, consumer_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Father / Husband Name</label>
                  <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} className="input-field" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Contact Number</label>
                  <input
                    value={form.consumer_phone}
                    onChange={(e) => setForm({ ...form, consumer_phone: e.target.value, whatsapp_number: form.whatsapp_same_as_mobile ? e.target.value : form.whatsapp_number })}
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">WhatsApp Number</label>
                  <input
                    value={form.whatsapp_same_as_mobile ? form.consumer_phone : form.whatsapp_number}
                    disabled={form.whatsapp_same_as_mobile}
                    onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })}
                    className="input-field disabled:opacity-60"
                  />
                  <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
                    <input type="checkbox" checked={form.whatsapp_same_as_mobile} onChange={(e) => setForm({ ...form, whatsapp_same_as_mobile: e.target.checked })} className="accent-dp-secondary w-3.5 h-3.5" />
                    <span className="font-sans text-[12px] text-dp-on-surface-variant">Same as contact number</span>
                  </label>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">House No.</label>
                  <input value={form.house_no} onChange={(e) => setForm({ ...form, house_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Sector</label>
                  <select value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} className="input-field">
                    <option value="">Select sector...</option>
                    {sectors.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Area</label>
                <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Full Address</label>
                <input value={form.consumer_address} onChange={(e) => setForm({ ...form, consumer_address: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Number of Connections</label>
                <input type="number" min={1} value={form.connections || ''} onChange={(e) => setForm({ ...form, connections: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Description (optional)</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="input-field" />
              </div>

              <div className="border border-dp-outline-variant rounded-lg p-3.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.wants_inventory_from_us} onChange={(e) => setForm({ ...form, wants_inventory_from_us: e.target.checked })} className="accent-dp-secondary w-4 h-4" />
                  <span className="font-sans text-[14px] font-semibold text-dp-on-surface">Consumer is purchasing this equipment from us</span>
                </label>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1">
                  {form.wants_inventory_from_us
                    ? 'These will be charged and deducted from stock when cash is received.'
                    : 'Shown as a checklist only — the consumer must arrange this equipment themselves and hand it to the plumber.'}
                </p>

                <div className="mt-3 border border-dp-outline-variant rounded-xl overflow-hidden bg-white">
                  {items.length === 0 ? (
                    <p className="px-4 py-6 text-center font-sans text-[13px] text-dp-on-surface-variant">No equipment items — add one below.</p>
                  ) : (
                    <div className="divide-y divide-dp-outline-variant">
                      {items.map((l, i) => {
                        const available = isLineAvailable(l)
                        return (
                          <div key={i} className="flex items-center gap-3 pl-3 pr-4 py-3 border-l-[3px] border-dp-secondary">
                            <div className="min-w-0 flex-1">
                              <p className="font-sans text-[14px] font-bold text-dp-on-surface truncate">{l.description}</p>
                              <p className="font-sans text-[12px] text-dp-on-surface-variant">
                                {l.quantity} unit(s){form.wants_inventory_from_us ? ` × Rs. ${fmtAmount(l.unit_price)}` : ''}
                              </p>
                            </div>
                            {form.wants_inventory_from_us && (
                              available ? (
                                <p className="text-right shrink-0 font-sans text-[14.5px] font-bold text-dp-on-surface">Rs. {fmtAmount(l.quantity * l.unit_price)}</p>
                              ) : (
                                <p className="text-right shrink-0 font-sans text-[12px] font-bold text-dp-error">Not available</p>
                              )
                            )}
                            <div className="flex items-center gap-1 shrink-0">
                              <button onClick={() => openEditItemLine(i)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer"><Pencil size={13} /></button>
                              <button onClick={() => removeItemLine(i)} className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><Trash2 size={13} /></button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="p-3 bg-dp-surface-container-low/50 border-t border-dp-outline-variant">
                    <button
                      onClick={() => { setCatalogSearch(''); refetchCatalog(); setItemModalStep('picker') }}
                      className="w-full flex items-center justify-center gap-2 py-2.5 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer"
                    >
                      <Plus size={16} /> Add Item
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between mb-1">
                <p className="font-sans text-[13px] font-semibold text-dp-on-surface-variant">Fixed Charges</p>
                <button
                  type="button"
                  onClick={() => setChargesLocked(!chargesLocked)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full font-sans text-[11.5px] font-bold uppercase tracking-wide cursor-pointer transition-all ${chargesLocked ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-amber-100 text-amber-800 hover:bg-amber-200'}`}
                  title={chargesLocked ? 'Unlock to override for this job' : 'Lock these charges again'}
                >
                  {chargesLocked ? <><Lock size={12} /> Locked</> : <><Unlock size={12} /> Unlocked</>}
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Plumber Charge</label>
                  <input type="number" min={0} disabled={chargesLocked} value={form.plumber_charge || ''} onChange={(e) => setForm({ ...form, plumber_charge: +e.target.value })} placeholder="0" className="input-field disabled:opacity-60 disabled:cursor-not-allowed" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Defaults from Settings — unlock to raise it for an unusual job.</p>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Digging Charge</label>
                  <input type="number" min={0} disabled={chargesLocked} value={form.digging_charge || ''} onChange={(e) => setForm({ ...form, digging_charge: +e.target.value })} placeholder="0" className="input-field disabled:opacity-60 disabled:cursor-not-allowed" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Defaults from Settings — unlock to raise it for an unusual job.</p>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Security Deposit</label>
                  <input type="number" min={0} disabled={chargesLocked} value={form.security_deposit_amount || ''} onChange={(e) => setForm({ ...form, security_deposit_amount: +e.target.value })} placeholder="0" className="input-field disabled:opacity-60 disabled:cursor-not-allowed" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">Defaults from Settings — unlock to raise it for an unusual job.</p>
                </div>
              </div>

              <div className="bg-white border border-dp-outline-variant rounded-xl p-5 flex items-center justify-between">
                <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.06em]">Total</span>
                <span className="font-heading text-[24px] font-bold text-dp-primary">Rs. {fmtAmount(total)}</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 p-4 border-t border-dp-outline-variant shrink-0">
              <button onClick={() => setPreviewOpen(true)} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 border-2 border-dp-secondary rounded-full font-sans text-[14px] font-bold text-dp-secondary hover:bg-dp-secondary/5 transition-all cursor-pointer">
                <Eye size={16} /> Preview
              </button>
              <button disabled={saving} onClick={confirmRequest} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {saving ? 'Saving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Item picker ---------------- */}
      {itemModalStep === 'picker' && (
        <div className="fixed inset-0 bg-black/50 z-[160] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setItemModalStep('closed')}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant shrink-0">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary">Add Item</h2>
              <button onClick={() => setItemModalStep('closed')} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
            </div>
            <div className="px-5 pt-4 shrink-0">
              <div className="relative">
                <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
                <input autoFocus value={catalogSearch} onChange={(e) => setCatalogSearch(e.target.value)} placeholder="Search items..." className="input-field !pl-10 text-[15px]" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-1 mt-2 min-h-[200px]">
              {inventoryItems.filter((it) => it.name.toLowerCase().includes(catalogSearch.trim().toLowerCase())).map((it) => (
                <button key={it.id} onClick={() => selectCatalogItem(it.id)} className="w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-lg hover:bg-dp-surface-container-low transition-all cursor-pointer text-left">
                  <span className="font-sans text-[14.5px] font-semibold text-dp-on-surface truncate">{it.name}</span>
                  {it.quantity_on_hand > 0 ? (
                    <span className="font-sans text-[13.5px] font-semibold text-dp-on-surface-variant shrink-0">Rs. {fmtAmount(it.unit_price)}</span>
                  ) : (
                    <span className="font-sans text-[12px] font-bold text-dp-error shrink-0">Not in stock</span>
                  )}
                </button>
              ))}
              {inventoryItems.length === 0 && <p className="px-3.5 py-8 text-center font-sans text-[13.5px] text-dp-on-surface-variant">No inventory items yet.</p>}
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Item detail ---------------- */}
      {itemModalStep === 'detail' && (
        <div className="fixed inset-0 bg-black/50 z-[160] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setItemModalStep('closed')}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-dp-outline-variant">
              <button onClick={() => setItemModalStep('picker')} className="p-1 -ml-1 text-dp-on-surface-variant hover:text-dp-on-surface cursor-pointer"><ChevronLeft size={20} /></button>
              <h2 className="font-heading text-[18px] font-bold text-dp-primary truncate">{editingItemIndex !== null ? 'Edit Item' : (activeItem?.name ?? 'Item')}</h2>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Quantity</label>
                  <input autoFocus type="number" min={0.01} step="0.01" value={newItemLine.quantity} onChange={(e) => setNewItemLine({ ...newItemLine, quantity: +e.target.value })} className="input-field text-[16px] font-semibold" />
                </div>
                <div>
                  <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Rate</label>
                  <input type="number" min={0} step="0.01" value={newItemLine.unit_price || ''} onChange={(e) => setNewItemLine({ ...newItemLine, unit_price: +e.target.value })} className="input-field text-[16px] font-semibold" />
                </div>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-dp-outline-variant">
                <span className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">Total</span>
                <span className="font-heading text-[22px] font-bold text-dp-primary">Rs. {fmtAmount(itemTotal)}</span>
              </div>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              {editingItemIndex === null && (
                <button onClick={saveItemAndNew} className="flex-1 px-4 py-3 border-2 border-dp-secondary rounded-full font-sans text-[14px] font-bold text-dp-secondary hover:bg-dp-secondary/5 transition-all cursor-pointer">Save & New</button>
              )}
              <button onClick={saveItemAndClose} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Preview / printable challan ---------------- */}
      {previewOpen && (
        <div className="fixed inset-0 bg-black/60 z-[170] flex items-center justify-center p-4 overflow-y-auto" onClick={() => setPreviewOpen(false)}>
          <div className="bg-white rounded-lg max-w-2xl w-full my-8" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Challan Preview</h2>
              <div className="flex items-center gap-2">
                <button disabled={printing} onClick={printChallan} className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-surface-container-low transition-all cursor-pointer">
                  <Printer size={14} /> {printing ? 'Preparing...' : 'Print'}
                </button>
                <button onClick={() => setPreviewOpen(false)} className="p-1 text-dp-on-surface-variant hover:text-dp-error cursor-pointer"><X size={20} /></button>
              </div>
            </div>
            <div className="p-5 flex justify-center overflow-x-auto">
              <div ref={challanRef} className="bg-white p-8" style={{ width: 560 }}>
                <div className="flex items-center justify-between mb-6 pb-4 border-b-2 border-dp-primary">
                  <div>
                    <h1 className="font-heading text-[22px] font-bold text-dp-primary">{branding?.companyNameEn || 'Dhab Pari Water & Welfare Committee'}</h1>
                    {branding?.companyEmail && <p className="text-[12px] text-dp-on-surface-variant">{branding.companyEmail}</p>}
                  </div>
                  <div className="text-right">
                    <p className="font-sans text-[13px] font-bold text-dp-primary uppercase tracking-wide">New Connection Challan</p>
                    <p className="font-sans text-[12px] text-dp-on-surface-variant">Date: {new Date(today()).toLocaleDateString('en-GB')}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mb-5 text-[13px] font-sans">
                  <div><span className="text-dp-on-surface-variant">Consumer Name:</span> <span className="font-semibold">{form.consumer_name || '—'}</span></div>
                  <div><span className="text-dp-on-surface-variant">Phone:</span> <span className="font-semibold">{form.consumer_phone || '—'}</span></div>
                  <div><span className="text-dp-on-surface-variant">Address:</span> <span className="font-semibold">{form.consumer_address || '—'}</span></div>
                  <div><span className="text-dp-on-surface-variant">Sector:</span> <span className="font-semibold">{form.sector || '—'}</span></div>
                </div>

                {items.length > 0 && (
                  <table className="w-full text-[12.5px] font-sans mb-2">
                    <thead>
                      <tr className="border-b border-dp-outline-variant text-left text-dp-on-surface-variant">
                        <th className="py-1.5">Item</th><th className="py-1.5 text-right">Qty</th>
                        {form.wants_inventory_from_us && (<><th className="py-1.5 text-right">Rate</th><th className="py-1.5 text-right">Amount</th></>)}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((l, i) => (
                        <tr key={i} className="border-b border-dp-outline-variant/50">
                          <td className="py-1.5">{l.description}</td>
                          <td className="py-1.5 text-right">{l.quantity}</td>
                          {form.wants_inventory_from_us && (
                            isLineAvailable(l) ? (
                              <>
                                <td className="py-1.5 text-right">{fmtAmount(l.unit_price)}</td>
                                <td className="py-1.5 text-right font-semibold">{fmtAmount(l.quantity * l.unit_price)}</td>
                              </>
                            ) : (
                              <td className="py-1.5 text-right font-semibold text-dp-error" colSpan={2}>Not available</td>
                            )
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {!form.wants_inventory_from_us && items.length > 0 && (
                  <p className="text-[11.5px] font-sans text-dp-on-surface-variant mb-4">Equipment listed above must be arranged by the consumer.</p>
                )}

                <div className="space-y-1 text-[13px] font-sans mb-5">
                  {form.plumber_charge > 0 && <div className="flex justify-between"><span className="text-dp-on-surface-variant">Plumber Charge</span><span>Rs. {fmtAmount(form.plumber_charge)}</span></div>}
                  {form.digging_charge > 0 && <div className="flex justify-between"><span className="text-dp-on-surface-variant">Digging Charge</span><span>Rs. {fmtAmount(form.digging_charge)}</span></div>}
                  {form.security_deposit_amount > 0 && <div className="flex justify-between"><span className="text-dp-on-surface-variant">Security Deposit (refundable)</span><span>Rs. {fmtAmount(form.security_deposit_amount)}</span></div>}
                  <div className="flex justify-between font-bold text-[15px] border-t border-dp-outline-variant pt-2 mt-2"><span>Total</span><span>Rs. {fmtAmount(total)}</span></div>
                </div>

                <div className="border-t border-dp-outline-variant pt-4 mt-4" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif', textAlign: 'right' }}>
                  <p className="text-[14px] font-bold mb-1.5">ہدایات</p>
                  <ul className="text-[13px] leading-relaxed list-disc list-inside space-y-1">
                    <li>یہ کنکشن 3 کام کے دنوں کے اندر نصب کر دیا جائے گا۔</li>
                    <li>براہ کرم اس چالان کو محفوظ رکھیں اور کام مکمل ہونے تک اپنے پاس رکھیں۔</li>
                    <li>تمام واجبات کی ادائیگی نقد وصول کی جائے گی اور با ضابطہ رسید فراہم کی جائے گی۔</li>
                    {form.security_deposit_amount > 0 && (
                      <li>سیکیورٹی ڈپازٹ کنکشن منقطع ہونے کی صورت میں واپس کر دیا جائے گا۔</li>
                    )}
                    {!form.wants_inventory_from_us && items.length > 0 && (
                      <li>مندرجہ بالا سامان پلمبر کو خود فراہم کرنا ہوگا۔ کام شروع کرنے کے لیے نقد ادائیگی ضروری ہے۔</li>
                    )}
                    <li>کسی بھی مسئلے کی صورت میں کمیٹی کے دفتر سے رابطہ کریں{branding?.helplineNumbers ? `: ${branding.helplineNumbers}` : '۔'}</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Cash Receive confirm ---------------- */}
      {cashReceiveTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-center justify-center p-4" onClick={() => setCashReceiveTarget(null)}>
          <div className="bg-white rounded-lg p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-1">Receive Cash</h2>
            <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-4">
              {cashReceiveTarget.consumer_name} — Rs. {fmtAmount(cashReceiveTarget.total_amount)}. This will create the consumer (if new), generate a bill, and record the payment as cash.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setCashReceiveTarget(null)} className="flex-1 px-4 py-2.5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={receivingCash} onClick={doCashReceive} className="flex-1 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {receivingCash ? 'Processing...' : 'Confirm Receive'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- Activation modal ---------------- */}
      {activationTarget && (
        <div className="fixed inset-0 bg-black/50 z-[150] flex items-end sm:items-center justify-center sm:p-4" onClick={() => setActivationTarget(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-dp-outline-variant">
              <CheckCircle2 size={20} className="text-dp-secondary" />
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">Activate Account</h2>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
                <p className="font-sans text-[14px] font-bold text-dp-on-surface">{activationTarget.consumer_name}</p>
                {activationForm.father_husband_name && (
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">S/O {activationForm.father_husband_name}</p>
                )}
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{activationTarget.consumer_id}</p>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">WhatsApp Number</label>
                <input value={activationForm.whatsapp_number} onChange={(e) => setActivationForm({ ...activationForm, whatsapp_number: e.target.value })} placeholder="03xx-xxxxxxx" className="input-field" />
                <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">The activation message sends here.</p>
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Monthly Bill Price</label>
                <input type="number" min={0} value={activationForm.monthly_amount || ''} onChange={(e) => setActivationForm({ ...activationForm, monthly_amount: +e.target.value })} placeholder="0" className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Discount (optional)</label>
                <input type="number" min={0} value={activationForm.discount_amount || ''} onChange={(e) => setActivationForm({ ...activationForm, discount_amount: +e.target.value })} placeholder="0" className="input-field" />
              </div>
              {activationForm.discount_amount > 0 && (
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant -mt-2">
                  Net monthly bill: <span className="font-bold text-dp-on-surface">Rs. {fmtAmount(Math.max(activationForm.monthly_amount - activationForm.discount_amount, 0))}</span>
                </p>
              )}
              <div>
                <label className="block font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-1.5">Description (optional)</label>
                <input value={activationForm.description} onChange={(e) => setActivationForm({ ...activationForm, description: e.target.value })} className="input-field" />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={activationForm.recurring_enabled} onChange={(e) => setActivationForm({ ...activationForm, recurring_enabled: e.target.checked })} className="accent-dp-secondary w-4 h-4" />
                <span className="font-sans text-[14px] font-semibold text-dp-on-surface flex items-center gap-1.5"><Clock size={14} /> Recurring Monthly Bill</span>
              </label>
            </div>
            <div className="flex gap-2 p-4 border-t border-dp-outline-variant">
              <button onClick={() => setActivationTarget(null)} className="flex-1 px-4 py-3 border border-dp-outline-variant rounded-full font-sans text-[14px] font-semibold text-dp-on-surface-variant hover:bg-dp-surface-container-low transition-all cursor-pointer">Cancel</button>
              <button disabled={activating || !activationForm.whatsapp_number.trim()} onClick={doActivate} className="flex-1 px-4 py-3 bg-dp-secondary text-white rounded-full font-sans text-[14px] font-bold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                <Wrench size={14} /> {activating ? 'Activating...' : 'Activate'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDeleteId}
        title="Delete Connection Request"
        message="This only removes the draft request — nothing has been billed yet for a request at this stage."
        onConfirm={deleteRequest}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  )
}
