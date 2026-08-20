'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ShieldCheck, Search, Plus, X, Save, Home, Users, CheckCircle2, Lock } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * The Verified Needs Register.
 *
 * Two screens in one, and which one you get depends on your permission:
 *
 *   A verifier sees households — names, addresses, the survey.
 *   Everyone else sees codes — MST-00042, a widow-headed household of six.
 *
 * That split is the whole promise the register is built on. People put their
 * names down because they were told the names stay inside a very small room,
 * and the code path here is the room's door rather than a note in a policy.
 */

interface SafeRow {
  id: string; code: string; asnaf_category: string; status: string
  household_size: number; dependants: number; earning_members: number
  is_widow_headed: boolean; has_orphans: boolean; orphan_count: number
  has_disabled_member: boolean; school_age_children: number
  housing: string | null; owns_land: boolean
  receives_bisp: boolean; receives_govt_zakat: boolean
  verified_at: string | null; verified_until: string | null
  source: string; created_at: string; verify_count: number
}

interface FullRow extends SafeRow {
  head_name: string; head_name_ur: string | null; father_husband_name: string | null
  cnic: string | null; phone: string | null; address: string | null; sector: string | null
  monthly_income_pkr: number | null; outstanding_debt_pkr: number | null
  livestock_note: string | null; notes: string | null
  family_consented: boolean; rejection_reason: string | null
}

const ASNAF = ['faqir', 'miskin', 'gharim', 'ibn_us_sabil', 'fi_sabilillah', 'riqab', 'muallaf', 'amil'] as const
const HOUSING = ['owned', 'rented', 'shared', 'kacha', 'homeless'] as const
const RELATIONSHIPS = ['none', 'sibling', 'close_relative', 'other', 'parent', 'child', 'spouse'] as const

const STATUS_TONE: Record<string, string> = {
  verified: 'bg-emerald-100 text-emerald-800',
  pending: 'bg-slate-100 text-slate-700',
  surveying: 'bg-amber-100 text-amber-800',
  rejected: 'bg-red-100 text-red-700',
  expired: 'bg-orange-100 text-orange-800',
  withdrawn: 'bg-slate-100 text-slate-500',
}

const emptyForm = {
  head_name: '', head_name_ur: '', father_husband_name: '', cnic: '', phone: '',
  address: '', sector: '', asnaf_category: 'faqir',
  household_size: 1, dependants: 0, earning_members: 0, monthly_income_pkr: 0,
  is_widow_headed: false, has_orphans: false, orphan_count: 0,
  has_disabled_member: false, school_age_children: 0,
  housing: 'owned', owns_land: false, livestock_note: '',
  outstanding_debt_pkr: 0, receives_bisp: false, receives_govt_zakat: false,
  notes: '', family_consented: true, source: 'survey',
}

export default function NeedsRegisterPage() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [isVerifier, setIsVerifier] = useState<boolean | null>(null)
  const [rows, setRows] = useState<SafeRow[]>([])
  const [full, setFull] = useState<Record<string, FullRow>>({})
  const [summary, setSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('verified')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [verifyTarget, setVerifyTarget] = useState<SafeRow | null>(null)
  const [verifyForm, setVerifyForm] = useState({ decision: 'verify', relationship: 'none', reason: '' })

  const load = useCallback(async () => {
    const { data: verifier } = await supabase.rpc('current_admin_is_needs_verifier')
    setIsVerifier(!!verifier)

    // Expired eligibility is swept on the way in, so the list is never showing
    // a household as verified on the strength of a visit made two years ago.
    await supabase.rpc('expire_needs_register')

    const [{ data: safe }, { data: sum }] = await Promise.all([
      supabase.rpc('needs_register_list'),
      supabase.rpc('needs_register_summary'),
    ])
    setRows((safe ?? []) as SafeRow[])
    setSummary((sum ?? {}) as Record<string, number>)

    if (verifier) {
      const { data: identities } = await supabase.from('needs_register').select('*')
      setFull(Object.fromEntries(((identities ?? []) as FullRow[]).map((r) => [r.id, r])))
    } else {
      setFull({})
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false
      if (!q) return true
      const identity = full[r.id]
      const blob = `${r.code} ${identity?.head_name ?? ''} ${identity?.phone ?? ''} ${identity?.address ?? ''}`
      return blob.toLowerCase().includes(q)
    })
  }, [rows, full, search, statusFilter, ])

  const save = async () => {
    if (!form.head_name.trim()) { toast.error(t('nr.err.name')); return }
    setSaving(true)
    const { error } = await supabase.from('needs_register').insert({
      ...form,
      head_name_ur: form.head_name_ur || null,
      father_husband_name: form.father_husband_name || null,
      cnic: form.cnic || null, phone: form.phone || null,
      address: form.address || null, sector: form.sector || null,
      livestock_note: form.livestock_note || null, notes: form.notes || null,
      consented_at: form.family_consented ? new Date().toISOString() : null,
      status: 'pending',
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('nr.ok.added'))
    setShowForm(false)
    setForm(emptyForm)
    load()
  }

  const submitVerification = async () => {
    if (!verifyTarget) return
    const { data: me } = await supabase.rpc('current_admin_user_id')
    if (!me) { toast.error(t('nr.err.notVerifier')); return }
    const { error } = await supabase.from('needs_verifications').upsert({
      register_id: verifyTarget.id, admin_user_id: me,
      decision: verifyForm.decision, relationship: verifyForm.relationship,
      reason: verifyForm.reason || null,
    }, { onConflict: 'register_id,admin_user_id' })
    if (error) { toast.error(friendlyError(error)); return }

    const { data: outcome, error: applyErr } = await supabase.rpc('needs_apply_verification', {
      p_register_id: verifyTarget.id,
    })
    if (applyErr) { toast.error(friendlyError(applyErr)); return }
    const o = outcome as { status: string; verifications: number; required: number }
    toast.success(
      o.status === 'verified' ? t('nr.ok.verified')
        : o.status === 'rejected' ? t('nr.ok.rejected')
          : `${t('nr.ok.recorded')} ${o.verifications}/${o.required}`
    )
    setVerifyTarget(null)
    setVerifyForm({ decision: 'verify', relationship: 'none', reason: '' })
    load()
  }

  const cards = [
    { key: 'verified_households', label: t('nr.card.verified'), icon: CheckCircle2 },
    { key: 'pending', label: t('nr.card.awaiting'), icon: Search },
    { key: 'widow_headed', label: t('nr.card.widows'), icon: Home },
    { key: 'with_orphans', label: t('nr.card.orphans'), icon: Users },
  ]

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
          <ShieldCheck size={26} className="text-dp-secondary" /> {t('nr.title')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('nr.blurb')}</p>
      </div>

      {isVerifier === false && (
        <div className="flex items-start gap-3 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
          <Lock size={16} className="text-dp-on-surface-variant shrink-0 mt-0.5" />
          <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('nr.codeOnlyNotice')}</p>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {cards.map((c) => (
          <div key={c.key} className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
            <div className="flex items-center gap-2 text-dp-on-surface-variant mb-1">
              <c.icon size={14} />
              <span className="font-sans text-[12px] font-semibold tracking-[0.04em]">{c.label}</span>
            </div>
            <p className="font-heading text-[24px] font-bold text-dp-primary">{summary[c.key] ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 left-3 text-dp-outline" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={isVerifier ? t('nr.searchAll') : t('nr.searchCode')} className="input-field ps-9" />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input-field w-auto">
          <option value="">{t('nr.allStatuses')}</option>
          {['verified', 'pending', 'surveying', 'rejected', 'expired'].map((s) => (
            <option key={s} value={s}>{t(`nr.status.${s}`)}</option>
          ))}
        </select>
        {isVerifier && (
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
            <Plus size={16} /> {t('nr.addHousehold')}
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                <th className="p-3 text-start">{t('nr.col.code')}</th>
                {isVerifier && <th className="p-3 text-start">{t('nr.col.household')}</th>}
                <th className="p-3 text-start">{t('nr.col.category')}</th>
                <th className="p-3 text-center">{t('nr.col.size')}</th>
                <th className="p-3 text-center">{t('nr.col.dependants')}</th>
                <th className="p-3 text-start">{t('nr.col.flags')}</th>
                <th className="p-3 text-start">{t('nr.col.status')}</th>
                <th className="p-3 text-end">{t('nr.col.action')}</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[14px]">
              {loading && <tr><td colSpan={8} className="p-8 text-center text-dp-on-surface-variant">{t('action.loading')}</td></tr>}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-dp-on-surface-variant">{t('nr.empty')}</td></tr>
              )}
              {!loading && filtered.map((r, i) => {
                const id = full[r.id]
                return (
                  <tr key={r.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                    <td className="p-3 border-b border-dp-outline-variant font-mono text-[12.5px] font-semibold">{r.code}</td>
                    {isVerifier && (
                      <td className="p-3 border-b border-dp-outline-variant">
                        <span className="font-semibold">{id?.head_name ?? '—'}</span>
                        {id?.address && <span className="block text-[12px] text-dp-on-surface-variant">{id.address}</span>}
                      </td>
                    )}
                    <td className="p-3 border-b border-dp-outline-variant">{t(`nr.asnaf.${r.asnaf_category}`)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center tabular-nums">{r.household_size}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center tabular-nums">{r.dependants}</td>
                    <td className="p-3 border-b border-dp-outline-variant">
                      <div className="flex flex-wrap gap-1">
                        {r.is_widow_headed && <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[10.5px] font-bold">{t('nr.flag.widow')}</span>}
                        {r.has_orphans && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('nr.flag.orphans')}</span>}
                        {r.has_disabled_member && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10.5px] font-bold">{t('nr.flag.disabled')}</span>}
                        {r.receives_bisp && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10.5px] font-bold">BISP</span>}
                      </div>
                    </td>
                    <td className="p-3 border-b border-dp-outline-variant">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${STATUS_TONE[r.status] ?? 'bg-slate-100'}`}>
                        {t(`nr.status.${r.status}`)}
                      </span>
                      {r.status !== 'verified' && r.verify_count > 0 && (
                        <span className="block text-[11px] text-dp-on-surface-variant mt-0.5">{r.verify_count} {t('nr.confirmed')}</span>
                      )}
                      {r.verified_until && (
                        <span className="block text-[11px] text-dp-on-surface-variant mt-0.5">
                          {t('nr.until')} {new Date(r.verified_until).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                        </span>
                      )}
                    </td>
                    <td className="p-3 border-b border-dp-outline-variant text-end">
                      {isVerifier && ['pending', 'surveying', 'expired'].includes(r.status) && (
                        <button onClick={() => { setVerifyTarget(r); setVerifyForm({ decision: 'verify', relationship: 'none', reason: '' }) }}
                          className="px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer whitespace-nowrap">
                          {t('nr.verify')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add a household ─────────────────────────────────────────────── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('nr.addHousehold')}</h2>
              <button onClick={() => setShowForm(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5 mb-4">
              {t('nr.privacyNotice')}
            </p>

            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.headName')}</label>
                  <input value={form.head_name} onChange={(e) => setForm({ ...form, head_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={form.head_name_ur} onChange={(e) => setForm({ ...form, head_name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.fatherHusband')}</label>
                  <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.phone')}</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" className="input-field" />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.address')}</label>
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="input-field" />
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.asnaf')}</label>
                <select value={form.asnaf_category} onChange={(e) => setForm({ ...form, asnaf_category: e.target.value })} className="input-field">
                  {ASNAF.map((a) => <option key={a} value={a}>{t(`nr.asnaf.${a}`)}</option>)}
                </select>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('nr.f.asnafHint')}</p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.size')}</label>
                  <input type="number" min={1} value={form.household_size || ''} onChange={(e) => setForm({ ...form, household_size: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.dependants')}</label>
                  <input type="number" min={0} value={form.dependants || ''} onChange={(e) => setForm({ ...form, dependants: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.earning')}</label>
                  <input type="number" min={0} value={form.earning_members || ''} onChange={(e) => setForm({ ...form, earning_members: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.schoolAge')}</label>
                  <input type="number" min={0} value={form.school_age_children || ''} onChange={(e) => setForm({ ...form, school_age_children: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.income')}</label>
                  <input type="number" min={0} value={form.monthly_income_pkr || ''} onChange={(e) => setForm({ ...form, monthly_income_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.debt')}</label>
                  <input type="number" min={0} value={form.outstanding_debt_pkr || ''} onChange={(e) => setForm({ ...form, outstanding_debt_pkr: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.housing')}</label>
                  <select value={form.housing} onChange={(e) => setForm({ ...form, housing: e.target.value })} className="input-field">
                    {HOUSING.map((h) => <option key={h} value={h}>{t(`nr.housing.${h}`)}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  ['is_widow_headed', 'nr.f.widowHeaded'],
                  ['has_orphans', 'nr.f.hasOrphans'],
                  ['has_disabled_member', 'nr.f.disabled'],
                  ['owns_land', 'nr.f.ownsLand'],
                  ['receives_bisp', 'nr.f.bisp'],
                  ['receives_govt_zakat', 'nr.f.govtZakat'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer font-sans text-[13.5px]">
                    <input type="checkbox" checked={form[key] as boolean}
                      onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="accent-dp-secondary" />
                    {t(label)}
                  </label>
                ))}
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.f.notes')}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="input-field resize-none" />
              </div>

              <label className="flex items-start gap-2 cursor-pointer font-sans text-[13px] bg-dp-surface-container-low rounded-lg px-3 py-2.5">
                <input type="checkbox" checked={form.family_consented}
                  onChange={(e) => setForm({ ...form, family_consented: e.target.checked })} className="accent-dp-secondary mt-0.5" />
                <span>{t('nr.f.consent')}</span>
              </label>

              <button disabled={saving} onClick={save}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Save size={16} /> {saving ? t('action.saving') : t('nr.addHousehold')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Record a verification ───────────────────────────────────────── */}
      {verifyTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setVerifyTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('nr.verifyTitle')}</h2>
              <button onClick={() => setVerifyTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-mono text-[13px] font-bold">{verifyTarget.code}</p>
              <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                {full[verifyTarget.id]?.head_name} · {verifyTarget.household_size} {t('nr.people')} · {verifyTarget.dependants} {t('nr.dependants')}
              </p>
            </div>

            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('nr.verifyBlurb')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.v.decision')}</label>
            <select value={verifyForm.decision} onChange={(e) => setVerifyForm({ ...verifyForm, decision: e.target.value })} className="input-field mb-3">
              <option value="verify">{t('nr.v.eligible')}</option>
              <option value="reject">{t('nr.v.notEligible')}</option>
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.v.relationship')}</label>
            <select value={verifyForm.relationship} onChange={(e) => setVerifyForm({ ...verifyForm, relationship: e.target.value })} className="input-field mb-1.5">
              {RELATIONSHIPS.map((r) => <option key={r} value={r}>{t(`nr.rel.${r}`)}</option>)}
            </select>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-3">{t('nr.v.relationshipHint')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('nr.v.reason')}</label>
            <textarea value={verifyForm.reason} onChange={(e) => setVerifyForm({ ...verifyForm, reason: e.target.value })}
              rows={2} className="input-field resize-none mb-4" />

            <button onClick={submitVerification}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer">
              <CheckCircle2 size={16} /> {t('nr.v.record')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
