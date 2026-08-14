'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Gift, X, Check, Wrench, AlertTriangle, MapPin, Plus } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

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
  const { t } = useLocale()
  const supabase = createClient()

  const [objects, setObjects] = useState<SadqaObject[]>([])
  const [catalogue, setCatalogue] = useState<CatalogueItem[]>([])
  const [liability, setLiability] = useState<Liability | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'proposals' | 'live' | 'catalogue'>('proposals')
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

  const proposals = objects.filter((o) => ['proposed'].includes(o.status))
  const live = objects.filter((o) => !['proposed', 'declined'].includes(o.status))
  const shown = tab === 'proposals' ? proposals : live

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
          <Gift size={26} className="text-dp-secondary" /> {t('es.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('es.blurb')}</p>
      </div>

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
              <p className="font-heading text-[20px] font-bold text-dp-error">Rs {fmt(liability.committee_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.donor')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(liability.donor_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.endowed')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(liability.endowed_annual)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.endowmentHeld')}</p>
              <p className="font-heading text-[20px] font-bold text-emerald-700">Rs {fmt(liability.endowment_held)}</p>
            </div>
            <div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('es.liab.spent12m')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(liability.spent_last_12m)}</p>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['proposals', `${t('es.tab.proposals')} (${proposals.length})`],
          ['live', `${t('es.tab.live')} (${live.length})`],
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
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                  <th className="p-3 text-start">{t('es.col.item')}</th>
                  <th className="p-3 text-end">{t('es.col.capital')}</th>
                  <th className="p-3 text-end">{t('es.col.running')}</th>
                  <th className="p-3 text-center">{t('es.col.life')}</th>
                </tr>
              </thead>
              <tbody className="font-sans text-[14px]">
                {catalogue.map((c, i) => (
                  <tr key={c.id} className={i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}>
                    <td className="p-3 border-b border-dp-outline-variant">
                      <span className="font-semibold">{c.name}</span>
                      {c.name_ur && <span className="block text-[13px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{c.name_ur}</span>}
                    </td>
                    <td className="p-3 border-b border-dp-outline-variant text-end tabular-nums">Rs {fmt(c.capital_cost_pkr)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-end tabular-nums">Rs {fmt(c.annual_running_cost_pkr)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center">{c.expected_life_years ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 font-sans text-[12px] text-dp-on-surface-variant border-t border-dp-outline-variant">{t('es.catalogueHint')}</p>
        </div>
      )}

      {!loading && tab !== 'catalogue' && (
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
                    {t('es.capital')}: <strong>Rs {fmt(o.capital_cost_pkr)}</strong> ·
                    {' '}{t('es.running')}: <strong>Rs {fmt(o.annual_running_cost_pkr)}/{t('es.year')}</strong> ·
                    {' '}{t(`es.mode.${o.maintenance_mode}`)}
                    {o.endowment_pkr > 0 && ` · ${t('es.endowment')} Rs ${fmt(o.endowment_pkr)}`}
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
                {t('es.f.newLiability')} <strong>Rs {fmt(liability.committee_annual + approveForm.running)}</strong>/{t('es.year')}
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
    </>
  )
}
