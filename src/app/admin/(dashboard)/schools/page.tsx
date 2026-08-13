'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { School, Plus, X, Save, Trash2, Layers, Bus } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The schools the committee actually pays fees to.
 *
 * One default fee cannot describe both the village government school, which
 * charges almost nothing, and a private school in Chakwal charging three
 * thousand a month — and every private school charges something different.
 *
 * Fees also climb with class: the same school billing Rs 1,500 for class 2
 * bills Rs 3,000 for class 9, and a child sponsored for six years passes
 * through both. So a school can carry tiers, and a child's package is built
 * from the fee their school charges for the class they are actually in.
 */

interface SchoolRow {
  id: string; name: string; name_ur: string | null; kind: string; location: string
  address: string | null; distance_km: number | null
  contact_phone: string | null; principal_name: string | null
  monthly_fee_pkr: number; months_charged: number
  admission_fee_pkr: number; annual_charges_pkr: number; exam_fee_pkr: number
  books_pkr: number; uniform_pkr: number
  provides_transport: boolean; transport_monthly_pkr: number
  concession_note: string | null; notes: string | null; is_active: boolean
}

interface Tier {
  id: string; school_id: string; label: string | null
  class_from: number; class_to: number
  monthly_fee_pkr: number; annual_charges_pkr: number
}

interface CostRow { id: string; name: string; kind: string; location: string; children: number; annual_cost: number }

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const KINDS = ['government', 'private', 'madrassa', 'college', 'vocational', 'other'] as const
const LOCATIONS = ['village', 'chakwal', 'other'] as const

// 0 is nursery, KG and prep together — nobody bills those three differently.
const CLASS_OPTIONS = [
  { v: 0, k: 'sc.class.pre' },
  ...Array.from({ length: 12 }, (_, i) => ({ v: i + 1, k: `` , n: i + 1 })),
]

const empty = {
  name: '', name_ur: '', kind: 'private', location: 'chakwal',
  address: '', distance_km: 0, contact_phone: '', principal_name: '',
  monthly_fee_pkr: 0, months_charged: 12,
  admission_fee_pkr: 0, annual_charges_pkr: 0, exam_fee_pkr: 0,
  books_pkr: 0, uniform_pkr: 0,
  provides_transport: false, transport_monthly_pkr: 0,
  concession_note: '', notes: '', is_active: true,
}

export default function SchoolsPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [schools, setSchools] = useState<SchoolRow[]>([])
  const [tiers, setTiers] = useState<Tier[]>([])
  const [costs, setCosts] = useState<CostRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<SchoolRow | null>(null)
  const [form, setForm] = useState(empty)
  const [showForm, setShowForm] = useState(false)
  const [tierTarget, setTierTarget] = useState<SchoolRow | null>(null)
  const [tierRows, setTierRows] = useState<{ label: string; class_from: number; class_to: number; monthly_fee_pkr: number; annual_charges_pkr: number }[]>([])

  const load = useCallback(async () => {
    const [{ data: s }, { data: ft }, { data: cs }] = await Promise.all([
      supabase.from('schools').select('*').order('location').order('name'),
      supabase.from('school_fee_tiers').select('*').order('class_from'),
      supabase.rpc('school_cost_summary'),
    ])
    setSchools((s ?? []) as SchoolRow[])
    setTiers((ft ?? []) as Tier[])
    setCosts((cs ?? []) as CostRow[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const open = (s?: SchoolRow) => {
    if (s) {
      setEditing(s)
      setForm({
        name: s.name, name_ur: s.name_ur ?? '', kind: s.kind, location: s.location,
        address: s.address ?? '', distance_km: Number(s.distance_km ?? 0),
        contact_phone: s.contact_phone ?? '', principal_name: s.principal_name ?? '',
        monthly_fee_pkr: Number(s.monthly_fee_pkr), months_charged: s.months_charged,
        admission_fee_pkr: Number(s.admission_fee_pkr), annual_charges_pkr: Number(s.annual_charges_pkr),
        exam_fee_pkr: Number(s.exam_fee_pkr), books_pkr: Number(s.books_pkr), uniform_pkr: Number(s.uniform_pkr),
        provides_transport: s.provides_transport, transport_monthly_pkr: Number(s.transport_monthly_pkr),
        concession_note: s.concession_note ?? '', notes: s.notes ?? '', is_active: s.is_active,
      })
    } else {
      setEditing(null); setForm(empty)
    }
    setShowForm(true)
  }

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('sc.err.name')); return }
    setBusy(true)
    const payload = {
      ...form,
      name: form.name.trim(),
      name_ur: form.name_ur || null, address: form.address || null,
      distance_km: form.distance_km || null,
      contact_phone: form.contact_phone || null, principal_name: form.principal_name || null,
      concession_note: form.concession_note || null, notes: form.notes || null,
      updated_at: new Date().toISOString(),
    }
    const { error } = editing
      ? await supabase.from('schools').update(payload).eq('id', editing.id)
      : await supabase.from('schools').insert(payload)
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editing ? t('sc.ok.updated') : t('sc.ok.added'))
    setShowForm(false)
    load()
  }

  const openTiers = (s: SchoolRow) => {
    const mine = tiers.filter((x) => x.school_id === s.id)
    setTierRows(mine.length > 0
      ? mine.map((x) => ({
          label: x.label ?? '', class_from: x.class_from, class_to: x.class_to,
          monthly_fee_pkr: Number(x.monthly_fee_pkr), annual_charges_pkr: Number(x.annual_charges_pkr),
        }))
      : [
          // The bands most schools here actually bill by.
          { label: 'Primary', class_from: 0, class_to: 5, monthly_fee_pkr: 0, annual_charges_pkr: 0 },
          { label: 'Middle', class_from: 6, class_to: 8, monthly_fee_pkr: 0, annual_charges_pkr: 0 },
          { label: 'Matric', class_from: 9, class_to: 10, monthly_fee_pkr: 0, annual_charges_pkr: 0 },
        ])
    setTierTarget(s)
  }

  const saveTiers = async () => {
    if (!tierTarget) return
    setBusy(true)
    await supabase.from('school_fee_tiers').delete().eq('school_id', tierTarget.id)
    const rows = tierRows.filter((r) => r.monthly_fee_pkr > 0 || r.annual_charges_pkr > 0).map((r) => ({
      school_id: tierTarget.id, label: r.label || null,
      class_from: r.class_from, class_to: r.class_to,
      monthly_fee_pkr: r.monthly_fee_pkr, annual_charges_pkr: r.annual_charges_pkr,
    }))
    const { error } = rows.length > 0
      ? await supabase.from('school_fee_tiers').insert(rows)
      : { error: null }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sc.ok.tiersSaved'))
    setTierTarget(null)
    load()
  }

  const costOf = (id: string) => costs.find((c) => c.id === id)
  const tiersOf = (id: string) => tiers.filter((x) => x.school_id === id)
  const annualOf = (s: SchoolRow) => Number(s.monthly_fee_pkr) * s.months_charged + Number(s.annual_charges_pkr)
  const label = 'block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1.5'
  const className = (n: number) => n === 0 ? t('sc.class.pre') : `${t('kf.class')} ${n}`

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <School size={26} className="text-dp-secondary" /> {t('sc.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('sc.blurb')}</p>
        </div>
        <button onClick={() => open()}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <Plus size={16} /> {t('sc.addSchool')}
        </button>
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && schools.length === 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('sc.empty')}</p>
        </div>
      )}

      <div className="space-y-3">
        {schools.map((s) => {
          const cost = costOf(s.id)
          const st = tiersOf(s.id)
          return (
            <div key={s.id} className={`bg-white border rounded-lg p-4 ${s.is_active ? 'border-dp-outline-variant' : 'border-dp-outline-variant opacity-60'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-sans text-[15.5px] font-bold text-dp-on-surface">{s.name}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${s.kind === 'government' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>
                      {t(`sc.kind.${s.kind}`)}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-dp-surface-container-low text-[11px] font-bold text-dp-on-surface-variant">
                      {t(`kf.loc.${s.location}`)}
                    </span>
                    {!s.is_active && (
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-bold">{t('sc.inactive')}</span>
                    )}
                  </div>
                  {s.name_ur && (
                    <p className="font-sans text-[13.5px] text-dp-on-surface-variant" style={{ fontFamily: 'var(--font-urdu), serif' }}>{s.name_ur}</p>
                  )}

                  <p className="font-sans text-[13px] text-dp-on-surface mt-1.5">
                    {Number(s.monthly_fee_pkr) > 0
                      ? <>Rs {fmt(s.monthly_fee_pkr)}/{t('sc.month')} × {s.months_charged} = <strong>Rs {fmt(annualOf(s))}/{t('es.year')}</strong></>
                      : <span className="text-emerald-700 font-semibold">{t('sc.noMonthlyFee')}</span>}
                    {Number(s.annual_charges_pkr) > 0 && Number(s.monthly_fee_pkr) === 0 && (
                      <span> · {t('sc.annualCharges')} Rs {fmt(s.annual_charges_pkr)}</span>
                    )}
                  </p>

                  {st.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {st.map((x) => (
                        <span key={x.id} className="px-2 py-0.5 rounded bg-dp-surface-container-low text-[11.5px] font-semibold">
                          {x.label || `${className(x.class_from)}–${className(x.class_to)}`}: Rs {fmt(x.monthly_fee_pkr)}
                        </span>
                      ))}
                    </div>
                  )}

                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5">
                    {Number(s.books_pkr) > 0 && `${t('kf.cat.books')} Rs ${fmt(s.books_pkr)} · `}
                    {Number(s.uniform_pkr) > 0 && `${t('kf.cat.uniform')} Rs ${fmt(s.uniform_pkr)} · `}
                    {Number(s.exam_fee_pkr) > 0 && `${t('kf.cat.exam_fee')} Rs ${fmt(s.exam_fee_pkr)}`}
                    {s.provides_transport && (
                      <span className="inline-flex items-center gap-1 ms-1">
                        <Bus size={12} /> Rs {fmt(s.transport_monthly_pkr)}/{t('sc.month')}
                      </span>
                    )}
                  </p>

                  {s.concession_note && (
                    <p className="font-sans text-[12.5px] text-emerald-700 mt-1">{s.concession_note}</p>
                  )}

                  {cost && cost.children > 0 && (
                    <p className="font-sans text-[12.5px] font-semibold text-dp-primary mt-2">
                      {cost.children} {t('sc.childrenHere')} · {t('sc.committeePays')} Rs {fmt(cost.annual_cost)}/{t('es.year')}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 shrink-0">
                  <button onClick={() => openTiers(s)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                    <Layers size={14} /> {t('sc.feeTiers')}
                  </button>
                  <button onClick={() => open(s)}
                    className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    {t('action.edit')}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* ── Add or edit a school ────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">
                {editing ? t('sc.editSchool') : t('sc.addSchool')}
              </h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className={label}>{t('sc.f.name')}</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('g.nameUrdu')}</label>
                  <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={label}>{t('sc.f.kind')}</label>
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="input-field">
                    {KINDS.map((k) => <option key={k} value={k}>{t(`sc.kind.${k}`)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>{t('sc.f.location')}</label>
                  <select value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="input-field">
                    {LOCATIONS.map((l) => <option key={l} value={l}>{t(`kf.loc.${l}`)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label}>{t('sc.f.distance')}</label>
                  <input type="number" min={0} step="0.5" value={form.distance_km || ''}
                    onChange={(e) => setForm({ ...form, distance_km: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('a.phone')}</label>
                  <input value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} className="input-field" />
                </div>
              </div>

              {/* ── The fee ─────────────────────────────────────────────── */}
              <div className="border border-dp-outline-variant rounded-lg p-3.5">
                <p className="font-sans text-[13px] font-bold text-dp-on-surface mb-1">{t('sc.s.fee')}</p>
                <p className="font-sans text-[12px] text-dp-on-surface-variant mb-3">{t('sc.s.feeHelp')}</p>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <label className={label}>{t('sc.f.monthlyFee')}</label>
                    <input type="number" min={0} value={form.monthly_fee_pkr || ''}
                      onChange={(e) => setForm({ ...form, monthly_fee_pkr: +e.target.value })} className="input-field" />
                  </div>
                  <div>
                    <label className={label}>{t('sc.f.monthsCharged')}</label>
                    <input type="number" min={1} max={12} value={form.months_charged || ''}
                      onChange={(e) => setForm({ ...form, months_charged: +e.target.value })} className="input-field" />
                    <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('sc.f.monthsHint')}</p>
                  </div>
                  <div>
                    <label className={label}>{t('sc.f.annualCharges')}</label>
                    <input type="number" min={0} value={form.annual_charges_pkr || ''}
                      onChange={(e) => setForm({ ...form, annual_charges_pkr: +e.target.value })} className="input-field" />
                  </div>
                </div>

                <p className="font-sans text-[13px] font-semibold text-dp-primary mt-3 bg-dp-surface-container-low rounded-lg px-3 py-2">
                  {t('sc.f.annualTotal')} Rs {fmt(form.monthly_fee_pkr * form.months_charged + form.annual_charges_pkr)}
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className={label}>{t('sc.f.admissionFee')}</label>
                  <input type="number" min={0} value={form.admission_fee_pkr || ''}
                    onChange={(e) => setForm({ ...form, admission_fee_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('kf.cat.books')}</label>
                  <input type="number" min={0} value={form.books_pkr || ''}
                    onChange={(e) => setForm({ ...form, books_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('kf.cat.uniform')}</label>
                  <input type="number" min={0} value={form.uniform_pkr || ''}
                    onChange={(e) => setForm({ ...form, uniform_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className={label}>{t('kf.cat.exam_fee')}</label>
                  <input type="number" min={0} value={form.exam_fee_pkr || ''}
                    onChange={(e) => setForm({ ...form, exam_fee_pkr: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="border border-dp-outline-variant rounded-lg p-3.5">
                <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px] mb-2">
                  <input type="checkbox" checked={form.provides_transport}
                    onChange={(e) => setForm({ ...form, provides_transport: e.target.checked })} className="accent-dp-secondary" />
                  {t('sc.f.providesTransport')}
                </label>
                {form.provides_transport && (
                  <div className="max-w-[200px]">
                    <label className={label}>{t('sc.f.transportMonthly')}</label>
                    <input type="number" min={0} value={form.transport_monthly_pkr || ''}
                      onChange={(e) => setForm({ ...form, transport_monthly_pkr: +e.target.value })} className="input-field" />
                  </div>
                )}
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-2">{t('sc.f.transportHint')}</p>
              </div>

              <div>
                <label className={label}>{t('sc.f.concession')}</label>
                <input value={form.concession_note} onChange={(e) => setForm({ ...form, concession_note: e.target.value })}
                  placeholder={t('sc.f.concessionPlaceholder')} className="input-field" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('sc.f.concessionHint')}</p>
              </div>

              <div>
                <label className={label}>{t('nr.f.notes')}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-field resize-none" />
              </div>

              <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                <input type="checkbox" checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" />
                {t('sc.f.active')}
              </label>

              <button disabled={busy} onClick={save}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {busy ? t('action.saving') : t('action.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Fee tiers by class ──────────────────────────────────────────── */}
      {tierTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setTierTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('sc.tiersTitle')}</h2>
              <button onClick={() => setTierTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] font-semibold text-dp-on-surface mb-1">{tierTarget.name}</p>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('sc.tiersHelp')}</p>

            <div className="space-y-2.5 mb-4">
              {tierRows.map((r, i) => (
                <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_auto_auto_1fr_1fr_auto] gap-2 items-end border-b border-dp-outline-variant pb-2.5">
                  <div>
                    <label className={label}>{t('sc.t.label')}</label>
                    <input value={r.label} onChange={(e) => { const n = [...tierRows]; n[i] = { ...r, label: e.target.value }; setTierRows(n) }}
                      className="input-field !py-2" />
                  </div>
                  <div>
                    <label className={label}>{t('sc.t.from')}</label>
                    <select value={r.class_from} onChange={(e) => { const n = [...tierRows]; n[i] = { ...r, class_from: +e.target.value }; setTierRows(n) }}
                      className="input-field !py-2 w-[110px]">
                      {CLASS_OPTIONS.map((c) => <option key={c.v} value={c.v}>{className(c.v)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={label}>{t('sc.t.to')}</label>
                    <select value={r.class_to} onChange={(e) => { const n = [...tierRows]; n[i] = { ...r, class_to: +e.target.value }; setTierRows(n) }}
                      className="input-field !py-2 w-[110px]">
                      {CLASS_OPTIONS.map((c) => <option key={c.v} value={c.v}>{className(c.v)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={label}>{t('sc.f.monthlyFee')}</label>
                    <input type="number" min={0} value={r.monthly_fee_pkr || ''}
                      onChange={(e) => { const n = [...tierRows]; n[i] = { ...r, monthly_fee_pkr: +e.target.value }; setTierRows(n) }}
                      className="input-field !py-2" />
                  </div>
                  <div>
                    <label className={label}>{t('sc.f.annualCharges')}</label>
                    <input type="number" min={0} value={r.annual_charges_pkr || ''}
                      onChange={(e) => { const n = [...tierRows]; n[i] = { ...r, annual_charges_pkr: +e.target.value }; setTierRows(n) }}
                      className="input-field !py-2" />
                  </div>
                  <button onClick={() => setTierRows(tierRows.filter((_, x) => x !== i))}
                    className="p-1.5 text-dp-on-surface-variant hover:text-dp-error cursor-pointer mb-1">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>

            <button onClick={() => setTierRows([...tierRows, { label: '', class_from: 0, class_to: 12, monthly_fee_pkr: 0, annual_charges_pkr: 0 }])}
              className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer mb-4">
              <Plus size={15} /> {t('sc.t.add')}
            </button>

            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">{t('sc.t.fallbackNote')}</p>

            <button disabled={busy} onClick={saveTiers}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Save size={16} /> {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
