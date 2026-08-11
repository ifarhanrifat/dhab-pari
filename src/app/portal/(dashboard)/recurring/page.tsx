'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { PlusCircle, X, Pause, Play, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Schedule {
  id: string; amount_pkr: number; frequency: string; next_run_date: string; is_active: boolean
  project_id: string | null; payment_method: string | null; particular: string | null
}
interface Project { id: string; title: string }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}
const empty = { amount_pkr: 0, frequency: 'monthly', next_run_date: new Date().toISOString().split('T')[0], project_id: '', payment_method: 'jazzcash', particular: '' }

export default function PortalRecurringPage() {
  const { t } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null)
  // Follows the reader's own language toggle, not the committee's setting —
  // this text is the one thing on the page they must actually understand.
  const { isUrdu } = useTranslation()
  const [policy, setPolicy] = useState<{ en: string; ur: string }>({ en: '', ur: '' })
  const [acknowledged, setAcknowledged] = useState(false)

  const load = async () => {
    if (!user) return
    const supabase = createClient()
    const [{ data: sched }, { data: proj }, { data: pol }] = await Promise.all([
      supabase.from('recurring_schedules').select('id, amount_pkr, frequency, next_run_date, is_active, project_id, payment_method, particular')
        .eq('created_by_portal_user_id', user.id).order('next_run_date', { ascending: true }),
      supabase.from('projects').select('id, title').neq('status', 'upcoming').order('title'),
      supabase.from('site_settings').select('key, value').in('key', ['recurring_policy_en', 'recurring_policy_ur']),
    ])
    setSchedules(sched ?? [])
    setProjects(proj ?? [])
    const v = Object.fromEntries((pol ?? []).map((x) => [x.key, x.value ?? '']))
    setPolicy({ en: v.recurring_policy_en ?? '', ur: v.recurring_policy_ur ?? '' })
    setLoading(false)
  }
  useEffect(() => { load() }, [user])

  const policyText = isUrdu ? (policy.ur || policy.en) : (policy.en || policy.ur)

  const save = async () => {
    if (!user || !form.amount_pkr || form.amount_pkr <= 0) { toast.error('Enter a valid amount'); return }
    // Announcing is the one action here that creates an obligation, so it does
    // not proceed until the donor has confirmed they understand what it means.
    if (policyText && !acknowledged) {
      toast.error(isUrdu ? 'براہ کرم پہلے شرائط پڑھ کر تصدیق کریں' : 'Please read and confirm the terms first')
      return
    }
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').insert({
      system: 'donors_projects', schedule_type: 'donation', created_by_portal_user_id: user.id,
      donor_name: user.full_name, donor_name_ur: user.name_ur, donor_phone: user.mobile, donor_type: 'villager',
      amount_pkr: form.amount_pkr, frequency: form.frequency, next_run_date: form.next_run_date,
      project_id: form.project_id || null, payment_method: form.payment_method,
      particular: form.particular || 'Recurring donation', is_active: true,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Recurring donation set up')
    setShowForm(false)
    setForm(empty)
    load()
  }

  const togglePause = async (s: Schedule) => {
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').update({ is_active: !s.is_active }).eq('id', s.id)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(s.is_active ? 'Paused' : 'Resumed')
    load()
  }

  const cancel = async () => {
    if (!confirmCancel) return
    const supabase = createClient()
    const { error } = await supabase.from('recurring_schedules').delete().eq('id', confirmCancel)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Cancelled')
    setConfirmCancel(null)
    load()
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary">{t('p.recurringDonations')}</h1>
          <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1">{t('p.recurringBlurb')}</p>
        </div>
        <button onClick={() => { setForm(empty); setAcknowledged(false); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">
          <PlusCircle size={16} /> {t('p.newSchedule')}
        </button>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        {schedules.length === 0 ? (
          <p className="px-5 py-8 text-center font-sans text-[14px] text-dp-on-surface-variant">{t('p.noRecurring')}</p>
        ) : (
          schedules.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant last:border-b-0">
              <div>
                <p className="font-sans text-[15px] font-bold text-dp-on-surface">Rs. {fmt(s.amount_pkr)} · <span className="capitalize">{s.frequency}</span></p>
                <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5">
                  {projects.find((p) => p.id === s.project_id)?.title ?? 'General Fund'} · Next: {new Date(s.next_run_date).toLocaleDateString('en-GB')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{s.is_active ? 'Active' : 'Paused'}</span>
                <button onClick={() => togglePause(s)} className="p-2 text-dp-on-surface-variant hover:text-dp-secondary cursor-pointer" title={s.is_active ? 'Pause' : 'Resume'}>
                  {s.is_active ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button onClick={() => setConfirmCancel(s.id)} className="p-2 text-dp-on-surface-variant hover:text-dp-error cursor-pointer" title="Cancel"><Trash2 size={16} /></button>
              </div>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog open={!!confirmCancel} title="Cancel Recurring Donation" message="Are you sure you want to cancel this recurring donation? This cannot be undone." onConfirm={cancel} onCancel={() => setConfirmCancel(null)} />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('p.newRecurring')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
                <input type="number" min={1} value={form.amount_pkr || ''} onChange={(e) => setForm({ ...form, amount_pkr: +e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.frequency')}</label>
                <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} className="input-field">
                  <option value="weekly">{t('w.weekly')}</option>
                  <option value="monthly">{t('w.monthly')}</option>
                  <option value="semi_annual">{t('w.semiAnnual')}</option>
                  <option value="yearly">{t('w.yearly')}</option>
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
                  {isUrdu ? 'پہلی قسط کی تاریخ' : 'Date of the first instalment'}
                </label>
                <input type="date" value={form.next_run_date} onChange={(e) => setForm({ ...form, next_run_date: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.project')}</label>
                <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className="input-field">
                  <option value="">{t('w.generalFund')}</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
                <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field">
                  <option value="jazzcash">{t('w.jazzcash')}</option>
                  <option value="easypaisa">{t('w.easypaisa')}</option>
                  <option value="bank">{t('w.bankTransfer')}</option>
                </select>
              </div>
              {/* The policy sits between the form and the button on purpose —
                  above the fields it gets scrolled past, below the button it is
                  read after the fact. */}
              {policyText && (
                <div
                  dir={isUrdu ? 'rtl' : 'ltr'}
                  className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
                  style={isUrdu ? { fontFamily: 'var(--font-urdu), serif' } : undefined}
                >
                  <p className="font-sans text-[13px] font-bold text-amber-900 mb-1.5">
                    {isUrdu ? 'اعلان کرنے سے پہلے' : 'Before you announce'}
                  </p>
                  <div className={`font-sans text-[12.5px] text-amber-900 whitespace-pre-line ${isUrdu ? 'leading-[2]' : 'leading-[1.65]'}`}>
                    {policyText}
                  </div>
                  <label className="flex items-start gap-2.5 mt-3 pt-3 border-t border-amber-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="accent-dp-secondary mt-0.5 cursor-pointer shrink-0"
                    />
                    <span className="font-sans text-[12.5px] font-semibold text-amber-900">
                      {isUrdu
                        ? 'میں نے یہ شرائط پڑھ لی ہیں اور سمجھ گیا ہوں کہ یہ ایک وعدہ ہے، خودکار ادائیگی نہیں۔'
                        : 'I have read this and understand that an announcement is a promise, not an automatic payment.'}
                    </span>
                  </label>
                </div>
              )}

              <button
                disabled={saving || (!!policyText && !acknowledged)}
                onClick={save}
                className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving
                  ? (isUrdu ? 'محفوظ ہو رہا ہے...' : 'Saving...')
                  : (isUrdu ? 'باقاعدہ عطیہ کا اعلان کریں' : 'Set Up Recurring Donation')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
