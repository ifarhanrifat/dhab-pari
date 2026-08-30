'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  Gift, X, Check, Wrench, AlertTriangle, MapPin, Plus, Pencil, HelpCircle, ChevronDown,
  HandCoins, Phone, RotateCcw, Info, Wallet,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { adminGuideKeys } from '@/lib/adminGuideContent'

/**
 * Esal-e-Sawab — lasting objects dedicated to the deceased.
 *
 * The screen is built around the one number the committee needs before it
 * says yes to anything: the annual running cost it has already taken on.
 * Twenty donated water coolers is a five-figure bill nobody voted for, and it
 * arrives one generous offer at a time.
 */

interface SadqaObject {
  id: string; object_no: string; item_name: string; item_name_ur: string | null
  donor_name: string; donor_is_anonymous: boolean; donor_phone: string | null
  dedicated_to: string; dedicated_to_ur: string | null; relationship: string | null
  plaque_text: string | null; dedication_note: string | null
  proposed_location: string | null; approved_location: string | null
  capital_cost_pkr: number; annual_running_cost_pkr: number
  maintenance_mode: string; endowment_pkr: number; amount_received_pkr: number
  status: string; installed_on: string | null; created_at: string
  actual_cost_pkr: number | null; settled_at: string | null
  maintenance_pool_id: string | null
}

interface CatalogueItem {
  id: string; name: string; name_ur: string | null
  capital_cost_pkr: number; annual_running_cost_pkr: number
  expected_life_years: number | null; is_active: boolean
}

interface Liability {
  committee_annual: number; donor_annual: number; endowed_annual: number
  endowment_held: number; live_objects: number; spent_last_12m: number
}

// The pool-collection side, folded in from what used to be a separate
// /admin/pools screen — same shapes as Kafalat's, scoped to POOL-SDQ only.
interface Position {
  pool_id: string; required: number; committed: number; received_this_month: number
  donors: number; coverage_percent: number; reserve_months: number; reserve_target_months: number
}
interface ShortMonth {
  pool_month_id: string; pool_code: string; month: string
  required: number; received: number; remaining: number
}
interface Lapsed { commitment_id: string; pool_code: string; name: string; phone: string | null; amount: number }
interface Cover { month: string; pool_code: string; amount: number; voucher_no: string | null }
interface Announcement {
  id: string; pool_code: string; donor_name: string | null; donor_phone: string | null
  amount: number; is_one_time: boolean; month: string; proof_url: string | null
  payment_batch_id: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

const STATUS_TONE: Record<string, string> = {
  proposed: 'bg-amber-100 text-amber-800',
  approved: 'bg-sky-100 text-sky-800',
  funded: 'bg-violet-100 text-violet-800',
  procured: 'bg-violet-100 text-violet-800',
  installed: 'bg-emerald-100 text-emerald-800',
  in_service: 'bg-emerald-100 text-emerald-800',
  needs_repair: 'bg-red-100 text-red-700',
  retired: 'bg-slate-100 text-slate-600',
  declined: 'bg-slate-100 text-slate-500',
}

// Only the steps that are genuinely a decision rather than a payment.
//
// 'approved -> funded' and 'funded -> procured' used to live here, which is
// how a button came to mark money as received when none had been. Those two
// are now consequences of sadqa_record_receipt() and sadqa_agree_bill(): the
// money moves, and the status follows it.
const FLOW: Record<string, string> = {
  procured: 'installed', installed: 'in_service', needs_repair: 'in_service',
}

export default function EsalESawabPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  // The "How this works" panel below, admin-editable (Settings → Donors &
  // Projects → Admin Guides — migration 309). Falls back to the original
  // messages.ts text if a field hasn't been customised yet.
  const [guideContent, setGuideContent] = useState<Record<string, string>>({})
  useEffect(() => {
    supabase.from('site_settings').select('key, value').in('key', adminGuideKeys('es')).then(({ data }) => {
      const m: Record<string, string> = {}
      ;((data ?? []) as { key: string; value: string | null }[]).forEach((s) => { m[s.key] = s.value ?? '' })
      setGuideContent(m)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const guideToggle = (guideContent[`es_guide_toggle_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t('es.guide.toggle')
  const guideTitle = (section: string, fallbackKey: string) => (guideContent[`es_guide_${section}_title_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t(`${fallbackKey}.title`)
  const guideBody = (section: string, fallbackKey: string) => (guideContent[`es_guide_${section}_body_${isUrdu ? 'ur' : 'en'}`] || '').trim() || t(`${fallbackKey}.body`)

  const [objects, setObjects] = useState<SadqaObject[]>([])
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
  const [liability, setLiability] = useState<Liability | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'proposals' | 'live' | 'catalogue' | 'collections'>('proposals')
  const [showGuide, setShowGuide] = useState(false)

  // ── Catalogue CRUD ────────────────────────────────────────────────────
  const [editingItem, setEditingItem] = useState<CatalogueItem | null>(null)
  const [showNewItem, setShowNewItem] = useState(false)
  const [itemForm, setItemForm] = useState({
    name: '', name_ur: '', capital_cost: 0, annual_running_cost: 0, expected_life_years: 0, description: '',
  })

  // ── Collections: shortfall, lapsed donors, announced pledges awaiting
  // confirmation — the same functionality Kafalat's admin page folded in,
  // scoped to just the shared Sadqa upkeep pool.
  const [poolId, setPoolId] = useState<string | null>(null)
  const [poolPosition, setPoolPosition] = useState<Position | null>(null)
  const [shortMonths, setShortMonths] = useState<ShortMonth[]>([])
  const [lapsed, setLapsed] = useState<Lapsed[]>([])
  const [covers, setCovers] = useState<Cover[]>([])
  const [unrestrictedAvailable, setUnrestrictedAvailable] = useState(0)
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [batchSummary, setBatchSummary] = useState<Record<string, { count: number; total: number }>>({})
  const [covering, setCovering] = useState<ShortMonth | null>(null)
  const [coverAmount, setCoverAmount] = useState(0)
  const [coverNote, setCoverNote] = useState('')
  const [approveTarget, setApproveTarget] = useState<SadqaObject | null>(null)
  const [approveForm, setApproveForm] = useState({ location: '', capital: 0, running: 0 })
  const [maintTarget, setMaintTarget] = useState<SadqaObject | null>(null)
  const [maintForm, setMaintForm] = useState({ kind: 'service', description: '', cost: 0, paid_by: 'committee' })
  const [busy, setBusy] = useState(false)

  // Recording what actually arrived, with the evidence behind it.
  const [receiptTarget, setReceiptTarget] = useState<SadqaObject | null>(null)
  const [receiptForm, setReceiptForm] = useState({
    amount: 0, method: 'bank', proof_url: '', cash_witness: '', received_on: '', note: '',
  })

  // The shop's bill, sent to the donor to agree before anything is posted.
  const [billTarget, setBillTarget] = useState<SadqaObject | null>(null)
  const [billForm, setBillForm] = useState({
    vendor: '', amount: 0, bill_no: '', bill_date: '', invoice_url: '', note: '',
  })

  const load = useCallback(async () => {
    const [{ data: objs }, { data: cat }, { data: liab }] = await Promise.all([
      supabase.from('sadqa_objects').select('*').order('created_at', { ascending: false }),
      supabase.from('sadqa_catalogue').select('*').order('display_order'),
      supabase.rpc('sadqa_maintenance_liability'),
    ])
    setObjects((objs ?? []) as SadqaObject[])
    setCatalogue((cat ?? []) as CatalogueItem[])
    setLiability((liab ?? null) as Liability | null)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const openApprove = (o: SadqaObject) => {
    setApproveForm({
      location: o.proposed_location ?? '',
      capital: o.capital_cost_pkr, running: o.annual_running_cost_pkr,
    })
    setApproveTarget(o)
  }

  const approve = async () => {
    if (!approveTarget) return
    setBusy(true)
    const { error } = await supabase.from('sadqa_objects').update({
      status: 'approved',
      approved_location: approveForm.location || approveTarget.proposed_location,
      capital_cost_pkr: approveForm.capital,
      annual_running_cost_pkr: approveForm.running,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', approveTarget.id)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.approved'))
    setApproveTarget(null)
    load()
  }

  const decline = async (o: SadqaObject) => {
    const { error } = await supabase.from('sadqa_objects')
      .update({ status: 'declined', updated_at: new Date().toISOString() }).eq('id', o.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.declined'))
    load()
  }

  const advance = async (o: SadqaObject) => {
    const next = FLOW[o.status]
    if (!next) return
    const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() }
    if (next === 'installed') patch.installed_on = new Date().toISOString().slice(0, 10)
    const { error } = await supabase.from('sadqa_objects').update(patch).eq('id', o.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.moved'))
    load()
  }

  const recordReceipt = async () => {
    if (!receiptTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_record_receipt', {
      p_object_id: receiptTarget.id,
      p_amount: receiptForm.amount,
      p_method: receiptForm.method,
      p_proof_url: receiptForm.proof_url || null,
      p_cash_witness: receiptForm.cash_witness || null,
      p_received_on: receiptForm.received_on || null,
      p_note: receiptForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.receiptRecorded'))
    setReceiptTarget(null)
    load()
  }

  const proposeBill = async () => {
    if (!billTarget) return
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_propose_bill', {
      p_object_id: billTarget.id,
      p_vendor: billForm.vendor,
      p_amount: billForm.amount,
      p_bill_no: billForm.bill_no || null,
      p_bill_date: billForm.bill_date || null,
      p_invoice_url: billForm.invoice_url || null,
      p_note: billForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.billSent'))
    setBillTarget(null)
    load()
  }

  const publishPool = async (o: SadqaObject) => {
    if (!confirm(t('es.publishPoolConfirm'))) return
    const { error } = await supabase.rpc('sadqa_publish_upkeep_pool', { p_object_id: o.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.poolPublished'))
    load()
  }

  const logMaintenance = async () => {
    if (!maintTarget) return
    setBusy(true)
    const { error } = await supabase.from('sadqa_maintenance_log').insert({
      object_id: maintTarget.id, kind: maintForm.kind,
      description: maintForm.description || null,
      cost_pkr: maintForm.cost, paid_by: maintForm.paid_by,
    })
    if (!error) {
      await supabase.from('sadqa_objects')
        .update({ last_checked_on: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
        .eq('id', maintTarget.id)
    }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.maintenanceLogged'))
    setMaintTarget(null)
    setMaintForm({ kind: 'service', description: '', cost: 0, paid_by: 'committee' })
    load()
  }

  // ── Catalogue CRUD ──────────────────────────────────────────────────────
  const openEditItem = (c: CatalogueItem) => {
    setItemForm({
      name: c.name, name_ur: c.name_ur ?? '', capital_cost: c.capital_cost_pkr,
      annual_running_cost: c.annual_running_cost_pkr, expected_life_years: c.expected_life_years ?? 0,
      description: '',
    })
    setEditingItem(c)
  }

  const saveNewItem = async () => {
    if (!itemForm.name.trim()) { toast.error(t('es.err.itemName')); return }
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_catalogue_create', {
      p_name: itemForm.name, p_name_ur: itemForm.name_ur || null,
      p_capital_cost: itemForm.capital_cost, p_annual_running_cost: itemForm.annual_running_cost,
      p_expected_life_years: itemForm.expected_life_years || null,
      p_description: itemForm.description || null, p_description_ur: null, p_image_url: null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.itemAdded'))
    setShowNewItem(false)
    setItemForm({ name: '', name_ur: '', capital_cost: 0, annual_running_cost: 0, expected_life_years: 0, description: '' })
    load()
  }

  const saveEditItem = async () => {
    if (!editingItem) return
    setBusy(true)
    const { error } = await supabase.rpc('sadqa_catalogue_update', {
      p_id: editingItem.id, p_name: itemForm.name, p_name_ur: itemForm.name_ur || null,
      p_capital_cost: itemForm.capital_cost, p_annual_running_cost: itemForm.annual_running_cost,
      p_expected_life_years: itemForm.expected_life_years || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('es.ok.itemSaved'))
    setEditingItem(null)
    load()
  }

  const retireItem = async (c: CatalogueItem, retire: boolean) => {
    if (retire && !confirm(t('es.retireConfirm'))) return
    const { error } = await supabase.rpc('sadqa_catalogue_retire', { p_id: c.id, p_retire: retire })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(retire ? t('es.ok.itemRetired') : t('es.ok.itemRestored'))
    load()
  }

  // ── Collections ──────────────────────────────────────────────────────────
  const loadCollections = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-SDQ').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setPoolId(pid)
    const [{ data: pos }, { data: short }, { data: ann }] = await Promise.all([
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('pool_shortfall_queue'),
      supabase.rpc('pool_announcement_queue'),
    ])
    setPoolPosition((pos ?? null) as Position | null)
    const s = short as { unrestricted_available: number; months: ShortMonth[]; lapsed: Lapsed[]; covers: Cover[] } | null
    setUnrestrictedAvailable(s?.unrestricted_available ?? 0)
    setShortMonths((s?.months ?? []).filter((m) => m.pool_code === 'POOL-SDQ'))
    setLapsed((s?.lapsed ?? []).filter((l) => l.pool_code === 'POOL-SDQ'))
    setCovers((s?.covers ?? []).filter((c) => c.pool_code === 'POOL-SDQ'))
    const sdqAnnouncements = ((ann ?? []) as Announcement[]).filter((a) => a.pool_code === 'POOL-SDQ')
    setAnnouncements(sdqAnnouncements)
    const batchIds = Array.from(new Set(sdqAnnouncements.filter((a) => a.payment_batch_id).map((a) => a.payment_batch_id as string)))
    if (batchIds.length > 0) {
      const { data: bs } = await supabase.rpc('payment_batch_summary', { p_batch_ids: batchIds })
      setBatchSummary((bs ?? {}) as Record<string, { count: number; total: number }>)
    } else {
      setBatchSummary({})
    }
  }, [supabase])

  // Loaded on mount, not gated on the tab being open — see the matching
  // note on /admin/kafalat for why a badge that only knows its own count
  // after you've already opened the tab is not a useful badge.
  useEffect(() => { loadCollections() }, [loadCollections])

  const confirmAnnouncement = async (a: Announcement) => {
    const entered = prompt(t('pool.confirmAmountPrompt').replace('{amt}', fmt(a.amount)), String(a.amount))
    if (entered === null) return
    const confirmedAmount = Number(entered)
    if (!confirmedAmount || confirmedAmount <= 0) { toast.error(t('pool.confirmAmountInvalid')); return }
    setBusy(true)
    const { error } = await supabase.rpc('pool_confirm_payment', {
      p_payment_id: a.id, p_confirmed_amount: confirmedAmount !== a.amount ? confirmedAmount : null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(confirmedAmount < a.amount ? t('pool.ok.confirmedPartial').replace('{amt}', fmt(confirmedAmount)) : t('pool.ok.confirmed'))
    loadCollections()
  }

  // pool_payments.proof_url is a path in the same private donation_receipts
  // bucket a general pledge's slip lives in (both now upload through
  // /portal/statement) — never a plain public URL, so it needs a signed
  // link minted per view, the same way /admin/donors already does it.
  const [viewingProofId, setViewingProofId] = useState<string | null>(null)
  const viewProof = async (id: string, path: string) => {
    setViewingProofId(id)
    const { data, error } = await supabase.storage.from('donation_receipts').createSignedUrl(path, 300)
    setViewingProofId(null)
    if (error || !data?.signedUrl) { toast.error('Could not open the payment screenshot'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  const declineAnnouncement = async (id: string) => {
    const reason = prompt(t('pool.declineReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('pool_decline_announcement', { p_payment_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.declined'))
    loadCollections()
  }

  const openCover = (m: ShortMonth) => {
    setCoverAmount(m.remaining)
    setCoverNote('')
    setCovering(m)
  }

  const submitCover = async () => {
    if (!covering) return
    setBusy(true)
    const { data, error } = await supabase.rpc('pool_cover_shortfall', {
      p_pool_month_id: covering.pool_month_id, p_amount: coverAmount, p_note: coverNote || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.covered').replace('{v}', (data as { voucher_no: string })?.voucher_no ?? ''))
    setCovering(null)
    loadCollections()
  }

  const proposals = objects.filter((o) => ['proposed'].includes(o.status))
  const live = objects.filter((o) => !['proposed', 'declined'].includes(o.status))
  const shown = tab === 'proposals' ? proposals : live

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <Gift size={26} className="text-dp-secondary" /> {t('es.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('es.blurb')}</p>
        </div>
        <button onClick={() => setShowGuide((v) => !v)}
          className="flex items-center gap-1.5 px-3.5 py-2.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[13.5px] font-semibold hover:border-dp-secondary transition-all cursor-pointer">
          <HelpCircle size={16} /> {guideToggle}
          <ChevronDown size={14} className={`transition-transform ${showGuide ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {showGuide && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-5 mb-5 space-y-4">
          {([
            ['proposals', 'es.guide.proposals'],
            ['upkeep', 'es.guide.upkeep'],
            ['collections', 'es.guide.collections'],
            ['catalogue', 'es.guide.catalogue'],
          ] as const).map(([key, base]) => (
            <div key={key}>
              <h4 className="font-heading text-[13.5px] font-bold text-dp-primary mb-1">{guideTitle(key, base)}</h4>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{guideBody(key, base)}</p>
            </div>
          ))}
        </div>
      )}

      {/* The number that should be read before accepting the next gift. */}
      {liability && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5">
          <div className="flex items-start gap-2 mb-3">
            <AlertTriangle size={15} className="text-amber-600 shrink-0 mt-0.5" />
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('es.liabilityNotice')}</p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.committee')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-error">{fmt(liability.committee_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.donor')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">{fmt(liability.donor_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.endowed')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">{fmt(liability.endowed_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.endowmentHeld')}</p>
              <p className="font-heading text-[20px] font-bold text-emerald-700">{fmt(liability.endowment_held)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.spent12m')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">{fmt(liability.spent_last_12m)}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['proposals', `${t('es.tab.proposals')} (${proposals.length})`],
          ['live', `${t('es.tab.live')} (${live.length})`],
          ['collections', `${t('es.tab.collections')}${(announcements.length + lapsed.length + shortMonths.length) ? ` (${announcements.length + lapsed.length + shortMonths.length})` : ''}`],
          ['catalogue', t('es.tab.catalogue')],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && tab === 'catalogue' && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
          <div className="flex justify-end p-3 border-b border-dp-outline-variant">
            <button onClick={() => { setItemForm({ name: '', name_ur: '', capital_cost: 0, annual_running_cost: 0, expected_life_years: 0, description: '' }); setShowNewItem(true) }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <Plus size={14} /> {t('es.addItem')}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                  <th className="p-3 text-start">{t('es.col.item')}</th>
                  <th className="p-3 text-end">{t('es.col.capital')}</th>
                  <th className="p-3 text-end">{t('es.col.running')}</th>
                  <th className="p-3 text-center">{t('es.col.life')}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="font-sans text-[14px]">
                {catalogue.map((c, i) => (
                  <tr key={c.id} className={`${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''} ${!c.is_active ? 'opacity-50' : ''}`}>
                    <td className="p-3 border-b border-dp-outline-variant">
                      <span className="font-semibold">{c.name}</span>
                      {c.name_ur && <span className="block text-[13px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{c.name_ur}</span>}
                      {!c.is_active && <span className="ms-2 px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10.5px] font-bold">{t('es.retired')}</span>}
                    </td>
                    <td className="p-3 border-b border-dp-outline-variant text-end tabular-nums">{fmt(c.capital_cost_pkr)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-end tabular-nums">{fmt(c.annual_running_cost_pkr)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center">{c.expected_life_years ?? '—'}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-end whitespace-nowrap">
                      <button onClick={() => openEditItem(c)} className="text-dp-on-surface-variant hover:text-dp-primary cursor-pointer me-2"><Pencil size={14} /></button>
                      <button onClick={() => retireItem(c, c.is_active)}
                        className="font-sans text-[11.5px] font-semibold text-dp-on-surface-variant hover:underline cursor-pointer">
                        {c.is_active ? t('es.retire') : t('es.restore')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 font-sans text-[12px] text-dp-on-surface-variant border-t border-dp-outline-variant">{t('es.catalogueHint')}</p>
        </div>
      )}

      {!loading && (tab === 'proposals' || tab === 'live') && (
        <div className="space-y-3">
          {shown.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('es.empty')}</p>
            </div>
          )}
          {shown.map((o) => (
            <div key={o.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{o.object_no}</span>
                    <span className="font-sans text-[15px] font-bold text-dp-on-surface">{o.item_name}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[o.status] ?? 'bg-slate-100'}`}>
                      {t(`es.status.${o.status}`)}
                    </span>
                  </div>

                  {/* The dedication is the point of the whole record. */}
                  <p className="font-sans text-[13.5px] text-dp-on-surface">
                    {t('es.inMemoryOf')} <strong>{o.dedicated_to}</strong>
                    {o.relationship && <span className="text-dp-on-surface-variant"> · {t(`es.rel.${o.relationship}`)}</span>}
                  </p>
                  {o.plaque_text && (
                    <p className="inline-block mt-1.5 px-3 py-1.5 rounded border-2 border-dp-outline-variant bg-dp-surface-container-low font-sans text-[12.5px] font-bold tracking-[0.04em]">
                      {o.plaque_text}
                    </p>
                  )}
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5">
                    {t('es.donatedBy')} {o.donor_is_anonymous ? t('f.anonymousDonor') : o.donor_name}
                    {(o.approved_location || o.proposed_location) && (
                      <span className="inline-flex items-center gap-1 ms-2">
                        <MapPin size={12} /> {o.approved_location || o.proposed_location}
                      </span>
                    )}
                  </p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">
                    {t('es.capital')}: <strong>{fmt(o.capital_cost_pkr)}</strong> ·
                    {' '}{t('es.running')}: <strong>{fmt(o.annual_running_cost_pkr)}/{t('es.year')}</strong> ·
                    {' '}{t(`es.mode.${o.maintenance_mode}`)}
                    {o.endowment_pkr > 0 && ` · ${t('es.endowment')} ${fmt(o.endowment_pkr)}`}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 shrink-0">
                  {o.status === 'proposed' && (
                    <>
                      <button onClick={() => openApprove(o)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                        <Check size={14} /> {t('es.approve')}
                      </button>
                      <button onClick={() => decline(o)}
                        className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                        {t('es.decline')}
                      </button>
                    </>
                  )}
                  {/* Money first. Status is what follows it. */}
                  {['approved', 'funded'].includes(o.status)
                    && (o.amount_received_pkr ?? 0) < (o.capital_cost_pkr ?? 0) && (
                    <button onClick={() => {
                      setReceiptForm({
                        amount: (o.capital_cost_pkr ?? 0) - (o.amount_received_pkr ?? 0),
                        method: 'bank', proof_url: '', cash_witness: '', received_on: '', note: '',
                      })
                      setReceiptTarget(o)
                    }}
                      className="px-3 py-1.5 rounded-lg bg-dp-secondary text-white font-sans text-[12.5px] font-semibold cursor-pointer">
                      {t('es.recordReceipt')}
                    </button>
                  )}

                  {(o.amount_received_pkr ?? 0) > 0 && !o.settled_at && (
                    <button onClick={() => {
                      setBillForm({ vendor: '', amount: o.capital_cost_pkr ?? 0, bill_no: '',
                                    bill_date: '', invoice_url: '', note: '' })
                      setBillTarget(o)
                    }}
                      className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[12.5px] font-semibold text-dp-on-surface cursor-pointer">
                      {t('es.sendBill')}
                    </button>
                  )}

                  {o.maintenance_mode === 'committee' && (o.annual_running_cost_pkr ?? 0) > 0
                    && !o.maintenance_pool_id && (
                    <button onClick={() => publishPool(o)}
                      className="px-3 py-1.5 rounded-lg border border-dp-outline-variant font-sans text-[12.5px] font-semibold text-dp-on-surface cursor-pointer">
                      {t('es.publishPool')}
                    </button>
                  )}

                  {FLOW[o.status] && (
                    <button onClick={() => advance(o)}
                      className="px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer whitespace-nowrap">
                      {t(`es.moveTo.${FLOW[o.status]}`)}
                    </button>
                  )}
                  {['in_service', 'needs_repair', 'installed'].includes(o.status) && (
                    <button onClick={() => setMaintTarget(o)}
                      className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer">
                      <Wrench size={14} /> {t('es.logMaintenance')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Collections: shortfall, lapsed donors, and pledges awaiting
          confirmation — folded in from what used to be a separate
          /admin/pools screen, scoped to just the shared upkeep pool. */}
      {!loading && tab === 'collections' && (
        <div className="space-y-6">
          {poolPosition && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                {[
                  { v: fmt(poolPosition.committed), l: t('pool.pledged') },
                  { v: String(poolPosition.donors), l: t('pool.donors') },
                  { v: `${poolPosition.coverage_percent}%`, l: t('kf.collections.coverage') },
                  { v: fmt(poolPosition.received_this_month), l: t('kf.collections.receivedThisMonth') },
                ].map((s) => (
                  <div key={s.l}>
                    <p className="font-heading text-[17px] font-bold text-dp-primary">{s.v}</p>
                    <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
                  </div>
                ))}
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant flex items-center gap-1.5">
                <Wallet size={12} />
                {t('pool.reserve').replace('{n}', String(poolPosition.reserve_months)).replace('{target}', String(poolPosition.reserve_target_months))}
              </p>
            </div>
          )}

          {announcements.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <HandCoins size={16} /> {t('pool.queueTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.queueBlurb')}</p>
              <div className="space-y-2">
                {announcements.map((a) => (
                  <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{a.donor_name ?? '—'}</p>
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {a.donor_phone && <a href={`tel:${a.donor_phone}`} className="text-dp-secondary hover:underline">{a.donor_phone}</a>}
                        {' · '}{fmt(a.amount)} · {a.is_one_time ? t('pool.oneTime') : t('pool.recurringMonthly')}
                      </p>
                      {a.payment_batch_id && batchSummary[a.payment_batch_id]?.count > 1 && (
                        <span title="Sent as one payment along with other pledges — some may be on other Collections tabs or /admin/donors"
                          className="inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded-full font-sans bg-amber-100 text-amber-800">
                          Part of {batchSummary[a.payment_batch_id].total.toLocaleString()} · {batchSummary[a.payment_batch_id].count} items
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {a.proof_url && (
                        <button onClick={() => viewProof(a.id, a.proof_url!)} disabled={viewingProofId === a.id}
                          className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer disabled:opacity-50">
                          {viewingProofId === a.id ? '...' : t('pool.viewProof')}
                        </button>
                      )}
                      <button onClick={() => confirmAnnouncement(a)} disabled={busy}
                        className="bg-dp-secondary text-white font-sans text-[12px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-50 cursor-pointer">
                        {t('pool.confirmThis')}
                      </button>
                      <button onClick={() => declineAnnouncement(a.id)}
                        className="font-sans text-[12px] font-bold text-dp-on-surface-variant hover:underline cursor-pointer">
                        {t('pool.declineThis')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lapsed.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <Phone size={16} /> {t('pool.lapsedTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.lapsedBlurb')}</p>
              <div className="space-y-2">
                {lapsed.map((l) => (
                  <div key={l.commitment_id} className="bg-white border border-dp-outline-variant rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">{l.name}</p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {l.phone && <a href={`tel:${l.phone}`} className="text-dp-secondary hover:underline">{l.phone}</a>}
                      {' · '}{fmt(l.amount)}/{t('pkf.month')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {shortMonths.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <AlertTriangle size={16} /> {t('pool.shortTitle')}
              </h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mb-2">{t('pool.shortBlurb').replace('{amt}', fmt(unrestrictedAvailable))}</p>
              <div className="space-y-2">
                {shortMonths.map((m) => (
                  <div key={m.pool_month_id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center gap-4">
                    <div className="flex-1 min-w-[200px]">
                      <p className="font-sans text-[12px] text-dp-on-surface-variant">
                        {new Date(m.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                        {' · '}{t('pool.neededReceived').replace('{req}', fmt(m.required)).replace('{recd}', fmt(m.received))}
                      </p>
                    </div>
                    <p className="font-heading text-[18px] font-bold text-dp-secondary">{fmt(m.remaining)}</p>
                    <button onClick={() => openCover(m)}
                      className="bg-dp-primary text-white font-sans text-[12.5px] font-bold px-4 py-2 rounded-lg hover:opacity-90 cursor-pointer">
                      {t('pool.coverIt')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {covers.length > 0 && (
            <div>
              <h3 className="font-heading text-[15px] font-bold text-dp-primary mb-1 flex items-center gap-2">
                <RotateCcw size={16} /> {t('pool.coversTitle')}
              </h3>
              <div className="space-y-2">
                {covers.map((c, i) => (
                  <div key={i} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">{new Date(c.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
                    <p className="font-sans text-[13px] font-semibold text-dp-on-surface">{fmt(c.amount)}</p>
                    <p className="font-mono text-[11.5px] text-dp-secondary">{c.voucher_no ?? '—'}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {announcements.length === 0 && lapsed.length === 0 && shortMonths.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.collections.allClear')}</p>
            </div>
          )}
        </div>
      )}

      {/* ── New / edit catalogue item ─────────────────────────────────── */}
      {(showNewItem || editingItem) && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => { setShowNewItem(false); setEditingItem(null) }}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{editingItem ? t('es.editItem') : t('es.addItem')}</h2>
              <button onClick={() => { setShowNewItem(false); setEditingItem(null) }} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.name')}</label>
            <input value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} className="input-field mb-3" />
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
            <input value={itemForm.name_ur} onChange={(e) => setItemForm({ ...itemForm, name_ur: e.target.value })}
              className="input-field mb-3" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.col.capital')}</label>
                <input type="number" min={0} value={itemForm.capital_cost || ''}
                  onChange={(e) => setItemForm({ ...itemForm, capital_cost: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.col.running')}</label>
                <input type="number" min={0} value={itemForm.annual_running_cost || ''}
                  onChange={(e) => setItemForm({ ...itemForm, annual_running_cost: +e.target.value })} className="input-field" />
              </div>
            </div>
            <label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.col.life')}</label>
            <input type="number" min={0} value={itemForm.expected_life_years || ''}
              onChange={(e) => setItemForm({ ...itemForm, expected_life_years: +e.target.value })} className="input-field mb-4" />
            <button disabled={busy} onClick={editingItem ? saveEditItem : saveNewItem}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Committee covers a shortfall ──────────────────────────────── */}
      {covering && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setCovering(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.coverTitle')}</h2>
              <button onClick={() => setCovering(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <Info size={15} className="text-dp-secondary shrink-0 mt-0.5" />
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pool.coverExplain')}</p>
            </div>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverAmount')}</label>
            <input type="number" min={1} max={covering.remaining} value={coverAmount}
              onChange={(e) => setCoverAmount(Number(e.target.value))} className="input-field mb-1.5" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3.5">{t('pool.availableIs').replace('{amt}', fmt(unrestrictedAvailable))}</p>
            <label className="block font-sans text-[12.5px] font-bold text-dp-primary mb-1.5">{t('pool.coverNote')}</label>
            <textarea value={coverNote} onChange={(e) => setCoverNote(e.target.value)} rows={2} className="input-field mb-4" />
            <button onClick={submitCover} disabled={busy}
              className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans font-semibold hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {busy ? t('action.saving') : t('pool.confirmCover')}
            </button>
          </div>
        </div>
      )}

      {/* ── Approve, with the site and the real costs ───────────────────── */}
      {approveTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setApproveTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('es.approveTitle')}</h2>
              <button onClick={() => setApproveTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5 mb-4">
              {t('es.waqfNotice')}
            </p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.approvedLocation')}</label>
            <input value={approveForm.location} onChange={(e) => setApproveForm({ ...approveForm, location: e.target.value })} className="input-field mb-3" />

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.capital')}</label>
                <input type="number" min={0} value={approveForm.capital || ''} onChange={(e) => setApproveForm({ ...approveForm, capital: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.running')}</label>
                <input type="number" min={0} value={approveForm.running || ''} onChange={(e) => setApproveForm({ ...approveForm, running: +e.target.value })} className="input-field" />
              </div>
            </div>

            {approveTarget.maintenance_mode === 'committee' && liability && (
              <p className="font-sans text-[12.5px] text-dp-error bg-red-50 border border-red-200 rounded-lg px-3 py-2.5 mb-4">
                {t('es.f.newLiability')} <strong>{fmt(liability.committee_annual + approveForm.running)}</strong>/{t('es.year')}
              </p>
            )}

            <button disabled={busy} onClick={approve}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Check size={16} /> {busy ? t('action.saving') : t('es.approve')}
            </button>
          </div>
        </div>
      )}

      {/* ── Maintenance log ─────────────────────────────────────────────── */}
      {maintTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setMaintTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('es.logMaintenance')}</h2>
              <button onClick={() => setMaintTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] font-semibold text-dp-on-surface mb-3">{maintTarget.object_no} · {maintTarget.item_name}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.m.kind')}</label>
            <select value={maintForm.kind} onChange={(e) => setMaintForm({ ...maintForm, kind: e.target.value })} className="input-field mb-3">
              {['check', 'service', 'repair', 'replacement_part', 'utility'].map((k) => (
                <option key={k} value={k}>{t(`es.m.${k}`)}</option>
              ))}
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.m.description')}</label>
            <textarea value={maintForm.description} onChange={(e) => setMaintForm({ ...maintForm, description: e.target.value })}
              rows={2} className="input-field resize-none mb-3" />

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.m.cost')}</label>
                <input type="number" min={0} value={maintForm.cost || ''} onChange={(e) => setMaintForm({ ...maintForm, cost: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.m.paidBy')}</label>
                <select value={maintForm.paid_by} onChange={(e) => setMaintForm({ ...maintForm, paid_by: e.target.value })} className="input-field">
                  <option value="committee">{t('es.mode.committee')}</option>
                  <option value="donor">{t('es.mode.donor')}</option>
                  <option value="endowment">{t('es.mode.endowed')}</option>
                </select>
              </div>
            </div>

            <button disabled={busy} onClick={logMaintenance}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Plus size={16} /> {busy ? t('action.saving') : t('es.m.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Recording money that actually arrived ──────────────────────
          The old button set a status and posted nothing. This one refuses to
          run without the transfer slip, or — for cash handed over in person,
          where there is no screenshot to have — the name of somebody who saw
          it happen. */}
      {receiptTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('es.receiptTitle')}</h3>
              <button onClick={() => setReceiptTarget(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                {t('es.receiptBlurb').replace('{item}', receiptTarget.item_name).replace('{donor}', receiptTarget.donor_name)}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.amount')}</label>
                  <input type="number" min={1} value={receiptForm.amount || ''}
                    onChange={(e) => setReceiptForm({ ...receiptForm, amount: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.method')}</label>
                  <select value={receiptForm.method}
                    onChange={(e) => setReceiptForm({ ...receiptForm, method: e.target.value })} className="input-field">
                    <option value="bank">{t('pool.method.bank')}</option>
                    <option value="cash">{t('pool.method.cash')}</option>
                    <option value="jazzcash">JazzCash</option>
                    <option value="easypaisa">EasyPaisa</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.proofUrl')}</label>
                <input value={receiptForm.proof_url}
                  onChange={(e) => setReceiptForm({ ...receiptForm, proof_url: e.target.value })}
                  placeholder="https://..." className="input-field" />
              </div>
              {receiptForm.method === 'cash' && !receiptForm.proof_url && (
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.cashWitness')}</label>
                  <input value={receiptForm.cash_witness}
                    onChange={(e) => setReceiptForm({ ...receiptForm, cash_witness: e.target.value })} className="input-field" />
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('es.f.cashWitnessHint')}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.receivedOn')}</label>
                  <input type="date" value={receiptForm.received_on}
                    onChange={(e) => setReceiptForm({ ...receiptForm, received_on: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.note')}</label>
                  <input value={receiptForm.note}
                    onChange={(e) => setReceiptForm({ ...receiptForm, note: e.target.value })} className="input-field" />
                </div>
              </div>
              <div className="flex gap-2.5">
                <button onClick={recordReceipt} disabled={busy || receiptForm.amount <= 0}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('action.saving') : t('es.confirmReceipt')}
                </button>
                <button onClick={() => setReceiptTarget(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px]">{t('action.cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Sending the shop's bill to the donor to agree ──────────────── */}
      {billTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('es.billTitle')}</h3>
              <button onClick={() => setBillTarget(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                {t('es.billBlurb').replace('{estimate}', fmt(billTarget.capital_cost_pkr)).replace('{received}', fmt(billTarget.amount_received_pkr))}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.vendor')}</label>
                  <input value={billForm.vendor}
                    onChange={(e) => setBillForm({ ...billForm, vendor: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.billAmount')}</label>
                  <input type="number" min={1} value={billForm.amount || ''}
                    onChange={(e) => setBillForm({ ...billForm, amount: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.billNo')}</label>
                  <input value={billForm.bill_no}
                    onChange={(e) => setBillForm({ ...billForm, bill_no: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.billDate')}</label>
                  <input type="date" value={billForm.bill_date}
                    onChange={(e) => setBillForm({ ...billForm, bill_date: e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('es.f.invoiceUrl')}</label>
                <input value={billForm.invoice_url}
                  onChange={(e) => setBillForm({ ...billForm, invoice_url: e.target.value })}
                  placeholder="https://..." className="input-field" />
              </div>
              {billForm.amount > 0 && (
                <p className="font-sans text-[12.5px] bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 text-dp-on-surface">
                  {billForm.amount === billTarget.capital_cost_pkr ? t('es.billSame')
                    : billForm.amount > billTarget.capital_cost_pkr
                      ? t('es.billDearer').replace('{amt}', fmt(billForm.amount - billTarget.capital_cost_pkr))
                      : t('es.billCheaper').replace('{amt}', fmt(billTarget.capital_cost_pkr - billForm.amount))}
                </p>
              )}
              <div className="flex gap-2.5">
                <button onClick={proposeBill} disabled={busy || !billForm.vendor.trim() || billForm.amount <= 0}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('action.saving') : t('es.sendToDonor')}
                </button>
                <button onClick={() => setBillTarget(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px]">{t('action.cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
