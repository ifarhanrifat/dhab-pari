'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { GraduationCap, X, Plus, Save, ShieldAlert, UserPlus, Bus } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Kafalat — sponsoring a school child.
 *
 * Two things are load-bearing here and neither is obvious from the outside.
 *
 * Safeguarding: nothing on this screen is ever public. Children are shown to
 * sponsors by first name behind a login, and the ledger only ever sees the
 * code. A village site that publishes a poor child's photograph and full name
 * does that child real damage in a place where everyone knows everyone.
 *
 * Transport: it is the line that decides whether a village child continues.
 * Nothing for the school here; about Rs 4,000 a month for the run into
 * Chakwal, which is more than the school fee. Building the package from lines
 * rather than one number is what makes that visible.
 */

interface Child {
  id: string; code: string; first_name: string; first_name_ur: string | null
  full_name: string; guardian_name: string; guardian_phone: string | null
  gender: string | null; date_of_birth: string | null
  is_orphan: boolean; orphan_type: string | null
  school_name: string | null; current_class: string | null
  school_location: string; status: string
  guardian_consent_signed: boolean; photo_consent: boolean; do_not_display: boolean
  created_at: string
}

interface PackageLine {
  id: string; child_id: string; academic_year: string; category: string
  description: string | null; annual_amount_pkr: number
}

interface Share {
  id: string; child_id: string; sponsor_name: string; is_anonymous: boolean
  share_percent: number; annual_amount_pkr: number; funded_by: string
  duration: string; starts_on: string; ends_on: string | null; status: string
}

interface Nomination {
  id: string; child_name: string; guardian_name: string | null
  approximate_age: number | null; gender: string | null
  address_hint: string | null; reason: string; status: string; created_at: string
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const CATEGORIES = ['school_fee', 'uniform', 'books', 'transport', 'pocket_money', 'medical', 'exam_fee', 'tuition', 'other'] as const
const currentAcademicYear = () => {
  // The Punjab school year runs April to March, so a date in January still
  // belongs to the session that started last April.
  const d = new Date()
  const start = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

const emptyChild = {
  first_name: '', first_name_ur: '', full_name: '', guardian_name: '',
  guardian_relation: 'father', guardian_phone: '', address: '',
  date_of_birth: '', gender: 'male', is_orphan: false, orphan_type: '',
  school_id: '', school_name: '', current_class: '', school_location: 'village',
  guardian_consent_signed: false, photo_consent: false,
}

export default function KafalatPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [children, setChildren] = useState<Child[]>([])
  const [lines, setLines] = useState<PackageLine[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [nominations, setNominations] = useState<Nomination[]>([])
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [schools, setSchools] = useState<{ id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[]>([])
  // What the chosen school actually charges for the class typed in, so the
  // committee sees the real number before the package is built rather than
  // after the challan arrives.
  const [feePreview, setFeePreview] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'children' | 'nominations'>('children')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyChild)
  const [busy, setBusy] = useState(false)
  const [packageChild, setPackageChild] = useState<Child | null>(null)
  const [editLines, setEditLines] = useState<{ category: string; annual_amount_pkr: number }[]>([])

  const load = useCallback(async () => {
    const [{ data: cs }, { data: ls }, { data: ss }, { data: ns }, { data: sum }, { data: sch }] = await Promise.all([
      supabase.from('kafalat_children').select('*').order('created_at', { ascending: false }),
      supabase.from('kafalat_package_lines').select('*'),
      supabase.from('kafalat_shares').select('*'),
      supabase.from('kafalat_nominations').select('*').order('created_at', { ascending: false }),
      supabase.rpc('public_kafalat_summary'),
      supabase.from('schools').select('id, name, kind, location, monthly_fee_pkr, months_charged')
        .eq('is_active', true).order('location').order('name'),
    ])
    setChildren((cs ?? []) as Child[])
    setLines((ls ?? []) as PackageLine[])
    setShares((ss ?? []) as Share[])
    setNominations((ns ?? []) as Nomination[])
    setSummary((sum ?? {}) as Record<string, number>)
    setSchools((sch ?? []) as { id: string; name: string; kind: string; location: string; monthly_fee_pkr: number; months_charged: number }[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const packageTotal = (childId: string) =>
    lines.filter((l) => l.child_id === childId).reduce((s, l) => s + Number(l.annual_amount_pkr || 0), 0)

  const committed = (childId: string) =>
    shares.filter((s) => s.child_id === childId && ['pledged', 'active'].includes(s.status))
      .reduce((s, x) => s + Number(x.share_percent || 0), 0)

  const previewFee = async (schoolId: string, currentClass: string) => {
    if (!schoolId) { setFeePreview(null); return }
    const { data } = await supabase.rpc('school_fee_for_class', {
      p_school_id: schoolId, p_class: currentClass || null,
    })
    setFeePreview((data ?? null) as Record<string, unknown> | null)
  }

  const addChild = async () => {
    if (!form.first_name.trim() || !form.full_name.trim() || !form.guardian_name.trim()) {
      toast.error(t('kf.err.required')); return
    }
    setBusy(true)
    const { data, error } = await supabase.from('kafalat_children').insert({
      ...form,
      school_id: form.school_id || null,
      first_name_ur: form.first_name_ur || null,
      guardian_phone: form.guardian_phone || null,
      address: form.address || null,
      date_of_birth: form.date_of_birth || null,
      orphan_type: form.is_orphan ? (form.orphan_type || 'father_deceased') : null,
      school_name: form.school_name || null,
      current_class: form.current_class || null,
      guardian_consent_at: form.guardian_consent_signed ? new Date().toISOString() : null,
      status: 'verified',
    }).select('id').single()
    if (error) { setBusy(false); toast.error(friendlyError(error)); return }

    // Prefills the package from the committee's own figures, with the
    // transport line following where the child actually studies.
    await supabase.rpc('kafalat_default_package', {
      p_child_id: data.id, p_academic_year: currentAcademicYear(),
    })
    setBusy(false)
    toast.success(t('kf.ok.added'))
    setShowForm(false)
    setForm(emptyChild)
    load()
  }

  const openPackage = (c: Child) => {
    const existing = lines.filter((l) => l.child_id === c.id)
    setEditLines(
      CATEGORIES.map((cat) => ({
        category: cat,
        annual_amount_pkr: Number(existing.find((l) => l.category === cat)?.annual_amount_pkr ?? 0),
      }))
    )
    setPackageChild(c)
  }

  const savePackage = async () => {
    if (!packageChild) return
    setBusy(true)
    const year = currentAcademicYear()
    await supabase.from('kafalat_package_lines').delete().eq('child_id', packageChild.id).eq('academic_year', year)
    const rows = editLines.filter((l) => l.annual_amount_pkr > 0).map((l) => ({
      child_id: packageChild.id, academic_year: year,
      category: l.category, annual_amount_pkr: l.annual_amount_pkr,
    }))
    const { error } = rows.length > 0
      ? await supabase.from('kafalat_package_lines').insert(rows)
      : { error: null }
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.packageSaved'))
    setPackageChild(null)
    load()
  }

  const activate = async (c: Child) => {
    if (!c.guardian_consent_signed) { toast.error(t('kf.err.consentFirst')); return }
    const { error } = await supabase.from('kafalat_children')
      .update({ status: 'active', joined_on: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
      .eq('id', c.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.activated'))
    load()
  }

  const reviewNomination = async (n: Nomination, status: string) => {
    const { error } = await supabase.from('kafalat_nominations')
      .update({ status, reviewed_at: new Date().toISOString() }).eq('id', n.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('kf.ok.nominationReviewed'))
    load()
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <GraduationCap size={26} className="text-dp-secondary" /> {t('kf.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('kf.blurb')}</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <UserPlus size={16} /> {t('kf.addChild')}
        </button>
      </div>

      <div className="flex items-start gap-2.5 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
        <ShieldAlert size={16} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('kf.safeguardingNotice')}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {([
          ['active_children', 'kf.card.active'],
          ['fully_sponsored', 'kf.card.full'],
          ['partly_sponsored', 'kf.card.partial'],
          ['awaiting_sponsor', 'kf.card.waiting'],
        ] as const).map(([key, label]) => (
          <div key={key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t(label)}</p>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{summary[key] ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {([
          ['children', `${t('kf.tab.children')} (${children.length})`],
          ['nominations', `${t('kf.tab.nominations')} (${nominations.filter((n) => n.status === 'new').length})`],
        ] as const).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3.5 py-2 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer transition-all ${tab === key ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && tab === 'children' && (
        <div className="space-y-3">
          {children.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.empty')}</p>
            </div>
          )}
          {children.map((c) => {
            const total = packageTotal(c.id)
            const pct = committed(c.id)
            const childShares = shares.filter((s) => s.child_id === c.id && ['pledged', 'active'].includes(s.status))
            return (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono text-[11.5px] text-dp-on-surface-variant">{c.code}</span>
                      <span className="font-sans text-[15px] font-bold text-dp-on-surface">{c.first_name}</span>
                      <span className="font-sans text-[13px] text-dp-on-surface-variant">({c.full_name})</span>
                      {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${c.status === 'active' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>
                        {t(`kf.status.${c.status}`)}
                      </span>
                      {!c.guardian_consent_signed && (
                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10.5px] font-bold">{t('kf.noConsent')}</span>
                      )}
                    </div>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                      {c.current_class && `${t('kf.class')} ${c.current_class} · `}
                      {c.school_name}
                      <span className="inline-flex items-center gap-1 ms-2">
                        <Bus size={12} /> {t(`kf.loc.${c.school_location}`)}
                      </span>
                    </p>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                      {t('kf.guardian')}: {c.guardian_name}{c.guardian_phone ? ` · ${c.guardian_phone}` : ''}
                    </p>

                    <div className="mt-2.5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-sans text-[13px] font-semibold text-dp-on-surface">Rs {fmt(total)}/{t('es.year')}</span>
                        <span className="font-sans text-[12.5px] text-dp-on-surface-variant">
                          · {pct}% {t('kf.sponsored')}{pct < 100 && ` · ${100 - pct}% ${t('kf.remaining')}`}
                        </span>
                      </div>
                      <div className="h-2 w-full max-w-xs bg-dp-surface-container rounded-full overflow-hidden">
                        <div className="h-full bg-dp-secondary" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      {childShares.length > 0 && (
                        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
                          {childShares.map((s) => `${s.is_anonymous ? t('f.anonymousDonor') : s.sponsor_name} ${s.share_percent}%`).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => openPackage(c)}
                      className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-primary transition-all cursor-pointer whitespace-nowrap">
                      {t('kf.editPackage')}
                    </button>
                    {c.status !== 'active' && (
                      <button onClick={() => activate(c)}
                        className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer whitespace-nowrap">
                        {t('kf.activate')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {!loading && tab === 'nominations' && (
        <div className="space-y-3">
          {nominations.length === 0 && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
              <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('kf.noNominations')}</p>
            </div>
          )}
          {nominations.map((n) => (
            <div key={n.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">
                  {n.child_name}
                  {n.approximate_age && <span className="font-normal text-dp-on-surface-variant"> · {n.approximate_age} {t('kf.years')}</span>}
                </p>
                {n.guardian_name && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('kf.guardian')}: {n.guardian_name}</p>}
                {n.address_hint && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{n.address_hint}</p>}
                <p className="font-sans text-[13px] text-dp-on-surface mt-1.5 italic">{n.reason}</p>
              </div>
              {n.status === 'new' ? (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => reviewNomination(n, 'screening')}
                    className="px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                    {t('kf.startScreening')}
                  </button>
                  <button onClick={() => reviewNomination(n, 'declined')}
                    className="px-3 py-1.5 border border-dp-outline-variant text-dp-on-surface-variant rounded-lg font-sans text-[12.5px] font-semibold hover:text-dp-error transition-all cursor-pointer">
                    {t('es.decline')}
                  </button>
                </div>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold shrink-0">{t(`kf.nstatus.${n.status}`)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Add a child ─────────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('kf.addChild')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.firstName')}</label>
                  <input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} className="input-field" />
                  <p className="font-sans text-[11px] text-dp-on-surface-variant mt-1">{t('kf.f.firstNameHint')}</p>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={form.first_name_ur} onChange={(e) => setForm({ ...form, first_name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.fullName')}</label>
                  <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardian')}</label>
                  <input value={form.guardian_name} onChange={(e) => setForm({ ...form, guardian_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardianRelation')}</label>
                  <select value={form.guardian_relation} onChange={(e) => setForm({ ...form, guardian_relation: e.target.value })} className="input-field">
                    {['mother', 'father', 'grandparent', 'uncle', 'aunt', 'sibling', 'other'].map((r) => (
                      <option key={r} value={r}>{t(`kf.grel.${r}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                  <input value={form.guardian_phone} onChange={(e) => setForm({ ...form, guardian_phone: e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.dob')}</label>
                  <input type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.gender')}</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="input-field">
                    <option value="male">{t('kf.boy')}</option>
                    <option value="female">{t('kf.girl')}</option>
                  </select>
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.class')}</label>
                  <input value={form.current_class}
                    onChange={(e) => { setForm({ ...form, current_class: e.target.value }); previewFee(form.school_id, e.target.value) }}
                    className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.schoolLocation')}</label>
                  <select value={form.school_location} onChange={(e) => setForm({ ...form, school_location: e.target.value })} className="input-field">
                    <option value="village">{t('kf.loc.village')}</option>
                    <option value="chakwal">{t('kf.loc.chakwal')}</option>
                    <option value="other">{t('kf.loc.other')}</option>
                  </select>
                </div>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant -mt-2">{t('kf.f.transportHint')}</p>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.school')}</label>
                <select value={form.school_id}
                  onChange={(e) => {
                    const sc = schools.find((x) => x.id === e.target.value)
                    setForm({
                      ...form, school_id: e.target.value,
                      school_name: sc?.name ?? form.school_name,
                      // The school knows where it is; the child's location
                      // follows from it rather than being asked twice.
                      school_location: sc?.location ?? form.school_location,
                    })
                    previewFee(e.target.value, form.current_class)
                  }}
                  className="input-field">
                  <option value="">{t('kf.f.schoolNotListed')}</option>
                  {schools.map((sc) => (
                    <option key={sc.id} value={sc.id}>
                      {sc.name} — {t(`sc.kind.${sc.kind}`)}{Number(sc.monthly_fee_pkr) > 0 ? ` · Rs ${fmt(sc.monthly_fee_pkr)}/${t('sc.month')}` : ''}
                    </option>
                  ))}
                </select>

                {!form.school_id && (
                  <input value={form.school_name} onChange={(e) => setForm({ ...form, school_name: e.target.value })}
                    placeholder={t('kf.f.schoolTypeName')} className="input-field mt-2" />
                )}

                {feePreview && (
                  <div className="mt-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5">
                    <p className="font-sans text-[12.5px] text-dp-on-surface">
                      {t('kf.f.feeForClass')} <strong>Rs {fmt(Number(feePreview.monthly_fee ?? 0))}</strong>/{t('sc.month')}
                      {' × '}{String(feePreview.months_charged ?? 12)}
                      {' = '}<strong>Rs {fmt(Number(feePreview.annual_fee ?? 0) + Number(feePreview.annual_charges ?? 0))}</strong>/{t('es.year')}
                      {feePreview.tier ? ` · ${String(feePreview.tier)}` : ''}
                    </p>
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{t('kf.f.feePreviewHint')}</p>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                <input type="checkbox" checked={form.is_orphan} onChange={(e) => setForm({ ...form, is_orphan: e.target.checked })} className="accent-dp-secondary" />
                {t('kf.f.isOrphan')}
              </label>
              {form.is_orphan && (
                <select value={form.orphan_type} onChange={(e) => setForm({ ...form, orphan_type: e.target.value })} className="input-field">
                  <option value="father_deceased">{t('kf.orphan.father')}</option>
                  <option value="mother_deceased">{t('kf.orphan.mother')}</option>
                  <option value="both_deceased">{t('kf.orphan.both')}</option>
                </select>
              )}

              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 space-y-2">
                <p className="font-sans text-[12.5px] font-bold text-dp-on-surface">{t('kf.consentHeading')}</p>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.guardian_consent_signed}
                    onChange={(e) => setForm({ ...form, guardian_consent_signed: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.consentSigned')}</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px]">
                  <input type="checkbox" checked={form.photo_consent}
                    onChange={(e) => setForm({ ...form, photo_consent: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                  <span>{t('kf.f.photoConsent')}</span>
                </label>
              </div>

              <button disabled={busy} onClick={addChild}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {busy ? t('action.saving') : t('kf.addChild')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── The package, line by line ───────────────────────────────────── */}
      {packageChild && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPackageChild(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('kf.packageTitle')}</h2>
              <button onClick={() => setPackageChild(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">
              {packageChild.code} · {packageChild.first_name} · {currentAcademicYear()}
            </p>

            <div className="space-y-2 mb-4">
              {editLines.map((l, idx) => (
                <div key={l.category} className="grid grid-cols-[1fr_140px] gap-2 items-center">
                  <label className="font-sans text-[13.5px] text-dp-on-surface">{t(`kf.cat.${l.category}`)}</label>
                  <input type="number" min={0} value={l.annual_amount_pkr || ''}
                    onChange={(e) => {
                      const next = [...editLines]
                      next[idx] = { ...l, annual_amount_pkr: +e.target.value }
                      setEditLines(next)
                    }}
                    className="input-field !py-2 text-end tabular-nums" />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-dp-outline-variant pt-3 mb-4">
              <span className="font-sans text-[13px] font-bold uppercase tracking-[0.05em] text-dp-on-surface-variant">{t('kf.annualTotal')}</span>
              <span className="font-heading text-[22px] font-bold text-dp-primary">
                Rs {fmt(editLines.reduce((s, l) => s + (l.annual_amount_pkr || 0), 0))}
              </span>
            </div>

            <button disabled={busy} onClick={savePackage}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Plus size={16} /> {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
