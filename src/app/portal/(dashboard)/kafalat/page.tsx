'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePortalUser } from '@/hooks/usePortalUser'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { GraduationCap, Heart, Users, X, Send, HandHeart } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Sponsoring a child, or joining the shared pool — one system, one form.
 *
 * There used to be two of these: naming a child through kafalat_shares (which
 * had no way to actually confirm a payment ever arrived, and was never
 * reconciled against what the committee still needed), and joining the
 * anonymous Mushtarka Kafalat pool through pool_announce. A donor had no way
 * to tell that giving to one did not also cover the other. They are now the
 * same action — announce an amount, recurring or once — with the only
 * difference being whether a child's name rides along with it. Both credit
 * the identical measuring account, so there is no longer a way for the two
 * figures to disagree.
 *
 * A child is never shown by family name, house or school-plus-photo, and a
 * child whose guardian has not consented to a photograph appears with their
 * initial instead — deliberately indistinguishable from a child who has no
 * photograph on file, so nothing is inferred from its absence.
 */

interface NamingChild {
  id: string; code: string; first_name: string; first_name_ur: string | null
  current_class: string | null; is_orphan: boolean
  this_year_requirement: number; already_named: number
  photo_url: string | null
}

interface Position {
  pool_id: string; required: number; committed: number; donors: number
  coverage_percent: number; suggested_share: number; min_share: number
}

interface Commitment {
  id: string; pool_id: string; monthly_amount: number; status: string; started_on: string
  named_child: string | null; paid_this_month: number; announced_this_month: number
  months_given: number; total_given: number
}

interface Announcement {
  id: string; amount: number; is_one_time: boolean; month: string
  status: string; named_child: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function PortalKafalatPage() {
  const { t } = useLocale()
  const supabase = createClient()
  const { user: portalUser } = usePortalUser()

  const [poolId, setPoolId] = useState<string | null>(null)
  const [position, setPosition] = useState<Position | null>(null)
  const [children, setChildren] = useState<NamingChild[]>([])
  const [commitments, setCommitments] = useState<Commitment[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // null target = the shared pool, no name attached.
  const [giving, setGiving] = useState<{ target: NamingChild | null } | null>(null)
  const [form, setForm] = useState({ amount: 0, recurring: true, funded_by: 'sadqa', show_name_publicly: false })

  const [showNominate, setShowNominate] = useState(false)
  const [nomination, setNomination] = useState({ child_name: '', guardian_name: '', approximate_age: 0, gender: 'male', address_hint: '', reason: '' })

  const [changing, setChanging] = useState<Commitment | null>(null)
  const [changeAmount, setChangeAmount] = useState(0)

  const load = useCallback(async () => {
    const { data: pool } = await supabase.from('support_pools').select('id').eq('code', 'POOL-KFL').single()
    const pid = (pool as { id: string } | null)?.id ?? null
    setPoolId(pid)

    const [{ data: kids }, { data: pos }, { data: myC }, { data: myA }] = await Promise.all([
      supabase.rpc('kafalat_children_for_naming'),
      pid ? supabase.rpc('pool_position', { p_pool_id: pid }) : Promise.resolve({ data: null }),
      supabase.rpc('my_pool_commitments'),
      supabase.rpc('my_pool_announcements'),
    ])
    setChildren((kids ?? []) as NamingChild[])
    setPosition((pos ?? null) as Position | null)
    setCommitments(((myC ?? []) as Commitment[]).filter((c) => c.pool_id === pid))
    setAnnouncements(((myA ?? []) as (Announcement & { pool_id: string })[]).filter((a) => a.pool_id === pid))
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const openGive = (child: NamingChild | null) => {
    const remaining = child ? Math.max(child.this_year_requirement - child.already_named, position?.min_share ?? 1000) : (position?.suggested_share ?? 2000)
    setForm({ amount: remaining, recurring: true, funded_by: 'sadqa', show_name_publicly: false })
    setGiving({ target: child })
  }

  const submitGive = async () => {
    if (!giving || !poolId || !portalUser) return
    if (position && form.amount < position.min_share) {
      toast.error(t('pool.minimumIs').replace('{amt}', fmt(position.min_share))); return
    }
    setBusy(true)
    const { error } = await supabase.rpc('pool_announce', {
      p_pool_id: poolId, p_amount: form.amount, p_recurring: form.recurring,
      p_funded_by: form.funded_by, p_show_name_publicly: form.show_name_publicly,
      p_kafalat_child_id: giving.target?.id ?? null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.announced'))
    setGiving(null)
    load()
  }

  const submitChange = async () => {
    if (!changing) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_change_my_share', {
      p_commitment_id: changing.id, p_monthly_amount: changeAmount,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.shareChanged'))
    setChanging(null)
    load()
  }

  const stopGiving = async (c: Commitment) => {
    if (!confirm(t('pool.leaveConfirm'))) return
    const { error } = await supabase.rpc('pool_leave', { p_commitment_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.left'))
    load()
  }

  const withdraw = async (a: Announcement) => {
    if (!confirm(t('pool.withdrawConfirm'))) return
    const { error } = await supabase.rpc('pool_cancel_announcement', { p_payment_id: a.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.withdrawn'))
    load()
  }

  const submitNomination = async () => {
    if (!nomination.child_name.trim() || !nomination.reason.trim()) { toast.error(t('pkf.err.nomination')); return }
    if (!portalUser) return
    setBusy(true)
    const { error } = await supabase.from('kafalat_nominations').insert({
      child_name: nomination.child_name.trim(),
      guardian_name: nomination.guardian_name || null,
      approximate_age: nomination.approximate_age || null,
      gender: nomination.gender,
      address_hint: nomination.address_hint || null,
      reason: nomination.reason.trim(),
      nominated_by_portal_user_id: portalUser.id,
      nominator_phone: portalUser.mobile ?? null,
      status: 'new',
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pkf.ok.nominated'))
    setShowNominate(false)
    setNomination({ child_name: '', guardian_name: '', approximate_age: 0, gender: 'male', address_hint: '', reason: '' })
  }

  const waitingChildren = children.filter((c) => c.already_named < c.this_year_requirement)

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <GraduationCap size={24} className="text-dp-secondary" /> {t('pkf.title')}
        </h1>
        <p className="font-sans text-[14px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('pkf.blurb')}</p>
      </div>

      <div className="bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-4 py-3 mb-5">
        <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">{t('pkf.poolNotice')}</p>
      </div>

      {/* ── My Kafalat giving ────────────────────────────────────────── */}
      {(commitments.length > 0 || announcements.length > 0) && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5">
          <h2 className="font-heading text-[15px] font-bold text-dp-primary mb-3">{t('pool.mine')}</h2>
          <div className="space-y-2.5">
            {commitments.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-dp-outline-variant last:border-0 pb-2.5 last:pb-0">
                <div>
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                    Rs {fmt(c.monthly_amount)}/{t('pkf.month')}
                    <span className="font-normal text-dp-on-surface-variant"> · {c.named_child ? t('pkf.namedFor').replace('{name}', c.named_child) : t('pkf.sharedGiving')}</span>
                  </p>
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant">
                    {t('pool.givenSoFar').replace('{months}', String(c.months_given)).replace('{total}', fmt(c.total_given))}
                    {c.status === 'lapsed' && <span className="text-amber-700 font-semibold"> · {t('pool.status.lapsed')}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => { setChangeAmount(c.monthly_amount); setChanging(c) }}
                    className="font-sans text-[12px] font-bold text-dp-secondary hover:underline cursor-pointer">{t('pool.changeAmount')}</button>
                  <button onClick={() => stopGiving(c)}
                    className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer">{t('pool.stopGiving')}</button>
                </div>
              </div>
            ))}
            {announcements.filter((a) => a.status === 'announced').map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-dp-outline-variant last:border-0 pb-2.5 last:pb-0">
                <div>
                  <p className="font-sans text-[13.5px] font-bold text-dp-on-surface">
                    Rs {fmt(a.amount)}
                    <span className="font-normal text-dp-on-surface-variant"> · {a.named_child ? t('pkf.namedFor').replace('{name}', a.named_child) : t('pkf.sharedGiving')}</span>
                  </p>
                  <p className="font-sans text-[11.5px] text-amber-700 font-semibold">{t('pool.status.announced')} — {t('pool.awaitingConfirmation')}</p>
                </div>
                <button onClick={() => withdraw(a)}
                  className="font-sans text-[12px] text-dp-on-surface-variant hover:underline cursor-pointer shrink-0">{t('pool.withdraw')}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Join the shared pool, no child named ────────────────────────
          The other half of the same choice: give without picking anyone,
          and it goes toward whichever child in the register needs it most. */}
      {position && (
        <div className="bg-white border-2 border-dp-secondary/30 rounded-lg p-4 mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-sans text-[14px] font-bold text-dp-on-surface flex items-center gap-2">
              <HandHeart size={16} className="text-dp-secondary" /> {t('pkf.sharedCard.title')}
            </p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1 max-w-md">{t('pkf.sharedCard.blurb')}</p>
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">
              {t('pool.nDonors').replace('{n}', String(position.donors))} · {position.coverage_percent}% {t('kf.sponsored')}
            </p>
          </div>
          <button onClick={() => openGive(null)}
            className="flex items-center gap-2 bg-dp-secondary text-white px-4 py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer shrink-0">
            <HandHeart size={15} /> {t('pool.join')}
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="font-heading text-[16px] font-bold text-dp-primary">{t('pkf.tab.available')}</h2>
        <button onClick={() => setShowNominate(true)}
          className="flex items-center gap-1.5 px-3.5 py-2 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer">
          <Users size={15} /> {t('pkf.nominate')}
        </button>
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && waitingChildren.length === 0 && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('pkf.allSponsored')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!loading && waitingChildren.map((c) => {
          const remaining = Math.max(c.this_year_requirement - c.already_named, 0)
          const pct = c.this_year_requirement > 0 ? Math.min(100, Math.round((c.already_named / c.this_year_requirement) * 100)) : 0
          return (
            <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <div className="flex items-start gap-3">
                {c.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.photo_url} alt="" className="w-14 h-14 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-dp-secondary/10 text-dp-secondary flex items-center justify-center font-heading text-[20px] font-bold shrink-0">
                    {c.first_name.charAt(0)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-sans text-[15px] font-bold text-dp-on-surface">{c.first_name}</span>
                    {c.is_orphan && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 text-[10.5px] font-bold">{t('kf.orphan')}</span>}
                  </div>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                    {c.current_class && `${t('kf.class')} ${c.current_class}`}
                  </p>
                  <p className="font-sans text-[13px] font-semibold text-dp-on-surface mt-1.5">
                    Rs {fmt(c.this_year_requirement)}/{t('es.year')}
                  </p>
                </div>
              </div>

              <div className="mt-3">
                <div className="h-2 w-full bg-dp-surface-container rounded-full overflow-hidden mb-1.5">
                  <div className="h-full bg-dp-secondary" style={{ width: `${Math.max(pct, 1)}%` }} />
                </div>
                <p className="font-sans text-[12px] text-dp-on-surface-variant">
                  {pct}% {t('kf.sponsored')} · <strong>Rs {fmt(remaining)} {t('kf.remaining')}</strong>
                </p>
              </div>

              <button onClick={() => openGive(c)}
                className="w-full mt-3 flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
                <Heart size={15} /> {c.already_named > 0 ? t('pkf.joinShare') : t('pkf.sponsor')}
              </button>
            </div>
          )
        })}
      </div>

      {/* ── Give — named or shared, same form ────────────────────────── */}
      {giving && position && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setGiving(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">
                {giving.target ? t('pkf.sponsorTitle') : t('pool.joinTitle')}
              </h2>
              <button onClick={() => setGiving(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            {giving.target && (
              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
                <p className="font-sans text-[15px] font-bold">{giving.target.first_name}</p>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant">
                  Rs {fmt(Math.max(giving.target.this_year_requirement - giving.target.already_named, 0))} {t('kf.remaining')} {t('es.year').toLowerCase()}
                </p>
              </div>
            )}

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">
              {t('pool.monthlyAmount')}
            </label>
            <input type="number" min={position.min_share} value={form.amount || ''}
              onChange={(e) => setForm({ ...form, amount: +e.target.value })}
              className="input-field mb-1" />
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-4">
              {t('pool.minimumIs').replace('{amt}', fmt(position.min_share))}
            </p>

            <div className="flex gap-2 mb-4">
              {([['recurring', true, 'pool.recurringMonthly'], ['one_time', false, 'pool.oneTime']] as const).map(([key, val, label]) => (
                <button key={key} onClick={() => setForm({ ...form, recurring: val })}
                  className={`flex-1 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer transition-all ${form.recurring === val ? 'bg-dp-secondary text-white' : 'border border-dp-outline-variant text-dp-on-surface-variant'}`}>
                  {t(label)}
                </button>
              ))}
            </div>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pool.fundedBy')}</label>
            <select value={form.funded_by} onChange={(e) => setForm({ ...form, funded_by: e.target.value })} className="input-field mb-1.5">
              <option value="sadqa">{t('pool.fundedBy.sadqa')}</option>
              <option value="general">{t('pool.fundedBy.general')}</option>
            </select>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mb-3.5">{t('pool.noZakat')}</p>

            <label className="flex items-start gap-2 cursor-pointer font-sans text-[12.5px] mb-5">
              <input type="checkbox" checked={form.show_name_publicly}
                onChange={(e) => setForm({ ...form, show_name_publicly: e.target.checked })} className="accent-dp-secondary mt-0.5" />
              <span>{t('pool.showNamePublicly')} <span className="block text-dp-on-surface-variant">{t('pool.showNamePubliclyHint')}</span></span>
            </label>

            <button disabled={busy || form.amount < position.min_share} onClick={submitGive}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <Heart size={16} /> {busy ? t('action.saving') : t('pool.confirmAnnounce')}
            </button>
            <p className="font-sans text-[11px] text-dp-on-surface-variant mt-3 text-center">{t('pool.announceTerms')}</p>
          </div>
        </div>
      )}

      {/* ── Change my standing amount ────────────────────────────────── */}
      {changing && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setChanging(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[18px] font-bold text-dp-primary">{t('pool.changeTitle')}</h2>
              <button onClick={() => setChanging(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={18} /></button>
            </div>
            <input type="number" min={1} value={changeAmount || ''}
              onChange={(e) => setChangeAmount(+e.target.value)} className="input-field mb-4" />
            <button disabled={busy} onClick={submitChange}
              className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              {busy ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Nominate a child ────────────────────────────────────────────── */}
      {showNominate && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowNominate(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('pkf.nominateTitle')}</h2>
              <button onClick={() => setShowNominate(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-4">{t('pkf.nominateHelp')}</p>

            <div className="space-y-3">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.childName')}</label>
                <input value={nomination.child_name} onChange={(e) => setNomination({ ...nomination, child_name: e.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('kf.f.guardian')}</label>
                  <input value={nomination.guardian_name} onChange={(e) => setNomination({ ...nomination, guardian_name: e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.age')}</label>
                  <input type="number" min={0} value={nomination.approximate_age || ''}
                    onChange={(e) => setNomination({ ...nomination, approximate_age: +e.target.value })} className="input-field" />
                </div>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.where')}</label>
                <input value={nomination.address_hint} onChange={(e) => setNomination({ ...nomination, address_hint: e.target.value })} className="input-field" />
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('pkf.n.reason')}</label>
                <textarea value={nomination.reason} onChange={(e) => setNomination({ ...nomination, reason: e.target.value })}
                  rows={3} className="input-field resize-none" />
              </div>

              <button disabled={busy} onClick={submitNomination}
                className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                <Send size={16} /> {busy ? t('action.saving') : t('pkf.sendNomination')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
