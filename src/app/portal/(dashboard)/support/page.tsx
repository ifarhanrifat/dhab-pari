'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  Users, X, Check, Info, ShieldCheck, Calendar, TrendingUp,
  HandCoins, AlertTriangle, Wallet,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Mushtarka Kafalat — the pooled monthly share.
 *
 * The whole reason this exists beside the named sponsorship: Rs 2,000 a month
 * is a decision somebody makes once, and Rs 100,000 a year is a decision they
 * postpone. Same money, different question.
 *
 * The instructions are not a footnote. Somebody about to commit to an open-
 * ended monthly payment deserves to know, before they click, exactly what
 * happens if they stop, whether their amount can be raised without asking
 * them, and what the committee does in a month too few people paid. All four
 * answers are on the page above the join button rather than in a policy nobody
 * opens — a donor who finds out the terms afterwards is a donor who leaves.
 */

interface Position {
  pool_id: string; code: string; name: string; name_ur: string | null
  kind: string; fund_type: string; required: number; committed: number
  received_this_month: number; committee_covered_this_month: number
  donors: number; coverage_percent: number; gap: number
  suggested_share: number; min_share: number; donors_needed: number
  share_if_all_split: number; reserve_months: number; reserve_target_months: number
  is_short: boolean
}

interface MyCommitment {
  id: string; pool: string; pool_ur: string | null; pool_id: string
  monthly_amount: number; status: string; funded_by: string; started_on: string
  paid_this_month: number; announced_this_month: number; months_given: number; total_given: number
}

interface MyAnnouncement {
  id: string; pool_id: string; pool: string; pool_ur: string | null
  amount: number; is_one_time: boolean; month: string; status: string
  has_proof: boolean; show_name_publicly: boolean; announced_at: string
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function PortalSupportPage() {
  // useSearchParams() forces a client bailout, so the page must sit behind a
  // Suspense boundary or the production build refuses to prerender it.
  return (
    <Suspense fallback={null}>
      <SupportBody />
    </Suspense>
  )
}

function SupportBody() {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const params = useSearchParams()
  const focusPool = params.get('pool')

  const [pools, setPools] = useState<Position[]>([])
  const [mine, setMine] = useState<MyCommitment[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [announcements, setAnnouncements] = useState<MyAnnouncement[]>([])

  const [joining, setJoining] = useState<Position | null>(null)
  const [form, setForm] = useState({
    monthly_amount: 2000, recurring: true, funded_by: 'sadqa', show_name_publicly: false,
  })
  const [editing, setEditing] = useState<MyCommitment | null>(null)
  const [newAmount, setNewAmount] = useState(0)

  const load = useCallback(async () => {
    const { data: list } = await supabase.from('support_pools')
      .select('id').eq('is_active', true)
    const positions = await Promise.all(
      (list ?? []).map((p: { id: string }) => supabase.rpc('pool_position', { p_pool_id: p.id })),
    )
    const { data: commitments } = await supabase.rpc('my_pool_commitments')
    const { data: announced } = await supabase.rpc('my_pool_announcements')
    setPools(positions.map((r) => r.data as Position).filter(Boolean))
    setMine((commitments ?? []) as MyCommitment[])
    setAnnouncements((announced ?? []) as MyAnnouncement[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const openJoin = (p: Position) => {
    setForm({ monthly_amount: p.suggested_share, recurring: true, funded_by: 'sadqa', show_name_publicly: false })
    setJoining(p)
  }

  const submitJoin = async () => {
    if (!joining) return
    setBusy(true)
    // Announces rather than joining outright — nothing is charged and nothing
    // counts as received until the accountant confirms it against real money.
    const { error } = await supabase.rpc('pool_announce', {
      p_pool_id: joining.pool_id,
      p_amount: form.monthly_amount,
      p_recurring: form.recurring,
      p_funded_by: form.funded_by,
      p_show_name_publicly: form.show_name_publicly,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.announced'))
    setJoining(null)
    load()
  }

  const withdrawAnnouncement = async (id: string) => {
    if (!confirm(t('pool.withdrawConfirm'))) return
    const { error } = await supabase.rpc('pool_cancel_announcement', { p_payment_id: id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.withdrawn'))
    load()
  }

  const attachProof = async (id: string) => {
    const url = prompt(t('pool.attachProof') + ' — ' + t('es.f.proofUrl') + ':')
    if (!url) return
    const { error } = await supabase.rpc('pool_attach_proof', { p_payment_id: id, p_proof_url: url })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.proofAttached'))
    load()
  }

  const submitChange = async () => {
    if (!editing) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_change_my_share', {
      p_commitment_id: editing.id, p_monthly_amount: newAmount,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.shareChanged'))
    setEditing(null)
    load()
  }

  const leave = async (c: MyCommitment) => {
    if (!confirm(t('pool.leaveConfirm'))) return
    const { error } = await supabase.rpc('pool_leave', { p_commitment_id: c.id })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.left'))
    load()
  }

  if (loading) {
    return <div className="font-sans text-[14px] text-dp-on-surface-variant">{t('common.loading')}</div>
  }

  const joinedIds = new Set(mine.filter((m) => m.status !== 'ended').map((m) => m.pool_id))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-[28px] font-bold text-dp-primary flex items-center gap-3">
          <Users size={26} /> {t('pool.title')}
        </h1>
        <p className="font-sans text-[18px] leading-[2] text-dp-primary font-bold mt-1"
          style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
          {t('pool.mottoUr')}
        </p>
        <p className="font-sans text-[14px] text-dp-on-surface-variant max-w-3xl leading-relaxed mt-1">
          {t('pool.intro')}
        </p>
      </div>

      {/* ── How this works, before anybody joins ──────────────────────────
          Every question a person actually has at the moment of committing to
          an open-ended monthly payment, answered in the order they ask them. */}
      <section className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
        <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center gap-2.5">
          <Info size={18} />
          <h2 className="font-heading text-[16px] font-bold">{t('pool.howTitle')}</h2>
        </div>

        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          {[
            { icon: HandCoins, k: 'what' },
            { icon: TrendingUp, k: 'amount' },
            { icon: Calendar, k: 'when' },
            { icon: X, k: 'stop' },
            { icon: AlertTriangle, k: 'short' },
            { icon: ShieldCheck, k: 'privacy' },
          ].map(({ icon: Icon, k }) => (
            <div key={k} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-dp-surface-container-low flex items-center justify-center shrink-0 mt-0.5">
                <Icon size={16} className="text-dp-secondary" />
              </div>
              <div className="min-w-0">
                <h3 className="font-heading text-[14px] font-bold text-dp-primary mb-1">
                  {t(`pool.how.${k}.q`)}
                </h3>
                <p className="font-sans text-[15px] leading-[2] text-dp-on-surface mb-1"
                  style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
                  {t(`pool.how.${k}.aUr`)}
                </p>
                <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                  {t(`pool.how.${k}.a`)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* The promise that matters most, and the one most easily broken by a
            well-meaning system: nobody's amount moves without them. */}
        <div className="border-t border-dp-outline-variant bg-dp-surface-container-low px-5 py-4 flex items-start gap-2.5">
          <ShieldCheck size={17} className="text-dp-secondary shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[15px] leading-[2] text-dp-on-surface font-bold"
              style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }}>
              {t('pool.promiseUr')}
            </p>
            <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
              {t('pool.promise')}
            </p>
          </div>
        </div>
      </section>

      {/* ── The pools ──────────────────────────────────────────────────── */}
      <section className="space-y-4">
        {pools.map((p) => {
          const joined = joinedIds.has(p.pool_id)
          const focused = focusPool === p.pool_id
          return (
            <div key={p.pool_id}
              className={`bg-white border rounded-lg overflow-hidden ${
                focused ? 'border-dp-secondary ring-1 ring-dp-secondary' : 'border-dp-outline-variant'}`}>

              <div className="bg-dp-primary text-white px-5 py-4">
                <h3 className="font-heading text-[17px] font-bold leading-tight">
                  {isUrdu && p.name_ur ? p.name_ur : p.name}
                </h3>
                <p className="font-sans text-[12.5px] opacity-85 mt-1">
                  {t('pool.needsPerMonth').replace('{amt}', fmt(p.required))}
                </p>
              </div>

              <div className="p-5">
                <div className="flex items-end justify-between gap-4 mb-2">
                  <p className="font-sans text-[13px] text-dp-on-surface">
                    <span className="font-heading text-[22px] font-bold text-dp-primary">
                      {fmt(p.committed)}
                    </span>
                    <span className="text-dp-on-surface-variant"> / {fmt(p.required)}</span>
                    <span className="text-dp-on-surface-variant">
                      {' · '}{t('pool.nDonors').replace('{n}', String(p.donors))}
                    </span>
                  </p>
                  <span className="font-heading text-[15px] font-bold text-dp-secondary tabular-nums">
                    {p.coverage_percent}%
                  </span>
                </div>

                <div className="h-2 rounded-full bg-dp-outline-variant overflow-hidden mb-4">
                  <div className="h-full bg-dp-secondary rounded-full transition-[width]"
                    style={{ width: `${Math.max(p.coverage_percent, 1)}%` }} />
                </div>

                {p.is_short ? (
                  <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 mb-4">
                    <Users size={14} className="text-dp-secondary shrink-0 mt-0.5" />
                    <p className="font-sans text-[12.5px] text-dp-on-surface leading-relaxed">
                      {t('pool.stillNeeds')
                        .replace('{n}', String(p.donors_needed))
                        .replace('{amt}', fmt(p.suggested_share))}
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5 mb-4">
                    <Check size={14} className="text-dp-secondary shrink-0 mt-0.5" />
                    <p className="font-sans text-[12.5px] text-dp-on-surface leading-relaxed">
                      {t('pool.fullyCovered')}
                    </p>
                  </div>
                )}

                {/* Reserve, stated plainly. A pool with no months in hand is
                    one lapsed donor away from a missed fee, and somebody
                    deciding whether to join should be able to see that. */}
                <div className="flex flex-wrap gap-x-6 gap-y-1 mb-4 font-sans text-[12px] text-dp-on-surface-variant">
                  <span className="flex items-center gap-1.5">
                    <Wallet size={13} />
                    {t('pool.reserve')
                      .replace('{n}', String(p.reserve_months))
                      .replace('{target}', String(p.reserve_target_months))}
                  </span>
                  {p.committee_covered_this_month > 0 && (
                    <span className="flex items-center gap-1.5 text-dp-secondary font-semibold">
                      <AlertTriangle size={13} />
                      {t('pool.committeeCovered').replace('{amt}', fmt(p.committee_covered_this_month))}
                    </span>
                  )}
                </div>

                {joined ? (
                  <span className="inline-flex items-center gap-1.5 font-sans text-[13px] font-bold text-dp-secondary">
                    <Check size={15} /> {t('pool.alreadyIn')}
                  </span>
                ) : (
                  <button onClick={() => openJoin(p)}
                    className="bg-dp-primary text-white font-sans text-[13.5px] font-bold px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity">
                    {t('pool.join')}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </section>

      {/* ── What I am already giving ───────────────────────────────────── */}
      {mine.length > 0 && (
        <section>
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">
            {t('pool.mine')}
          </h2>
          <div className="space-y-3">
            {mine.map((c) => (
              <div key={c.id}
                className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[200px]">
                  <p className="font-heading text-[14px] font-bold text-dp-primary">
                    {isUrdu && c.pool_ur ? c.pool_ur : c.pool}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                    {t('pool.givenSoFar')
                      .replace('{months}', String(c.months_given))
                      .replace('{total}', fmt(c.total_given))}
                  </p>
                </div>

                <div className="text-center">
                  <p className="font-heading text-[18px] font-bold text-dp-primary">
                    {fmt(c.monthly_amount)}
                  </p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">
                    {t('pool.perMonth')}
                  </p>
                </div>

                <span className={`font-sans text-[11px] font-bold px-2.5 py-1 rounded-full ${
                  c.status === 'active' ? 'bg-dp-secondary/10 text-dp-secondary'
                    : c.status === 'lapsed' ? 'bg-amber-50 text-amber-700'
                    : 'bg-dp-surface-container-low text-dp-on-surface-variant'}`}>
                  {t(`pool.status.${c.status}`)}
                </span>

                {/* This month's own announcement, if there is one open — the
                    donor's evidence that they said something, before the
                    accountant has acted on it. */}
                {c.announced_this_month > 0 && (
                  <span className="font-sans text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700">
                    {t('pool.status.announced')} · {fmt(c.announced_this_month)}
                  </span>
                )}

                {c.status !== 'ended' && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setEditing(c); setNewAmount(c.monthly_amount) }}
                      className="font-sans text-[12.5px] font-bold text-dp-secondary hover:underline">
                      {t('pool.changeAmount')}
                    </button>
                    <button onClick={() => leave(c)}
                      className="font-sans text-[12.5px] text-dp-on-surface-variant hover:underline">
                      {t('pool.stopGiving')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── My announcements ─────────────────────────────────────────────
          Recurring or one-time, this is the donor's own record of what they
          said they would send — visible from the moment they announce it,
          withdrawable right up until the accountant confirms it. */}
      {announcements.filter((a) => a.status === 'announced').length > 0 && (
        <section>
          <h2 className="font-heading text-[18px] font-bold text-dp-primary mb-3">
            {t('pool.myAnnouncements')}
          </h2>
          <div className="space-y-2.5">
            {announcements.filter((a) => a.status === 'announced').map((a) => (
              <div key={a.id}
                className="bg-white border border-amber-200 bg-amber-50/40 rounded-lg p-4 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[180px]">
                  <p className="font-heading text-[14px] font-bold text-dp-primary">
                    {isUrdu && a.pool_ur ? a.pool_ur : a.pool}
                  </p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                    {a.is_one_time ? t('pool.oneTime') : t('pool.recurringMonthly')}
                    {' · '}{new Date(a.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                  </p>
                </div>
                <p className="font-heading text-[16px] font-bold text-dp-primary">Rs {fmt(a.amount)}</p>
                <span className="font-sans text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800">
                  {t('pool.awaitingConfirmation')}
                </span>
                <div className="flex gap-3">
                  {!a.has_proof && (
                    <button onClick={() => attachProof(a.id)}
                      className="font-sans text-[12.5px] font-bold text-dp-secondary hover:underline">
                      {t('pool.attachProof')}
                    </button>
                  )}
                  <button onClick={() => withdrawAnnouncement(a.id)}
                    className="font-sans text-[12.5px] text-dp-on-surface-variant hover:underline">
                    {t('pool.withdraw')}
                  </button>
                </div>
                {a.has_proof && (
                  <p className="font-sans text-[11.5px] text-dp-secondary w-full">{t('pool.proofAttached')}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Join ───────────────────────────────────────────────────────── */}
      {joining && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('pool.joinTitle')}</h3>
              <button onClick={() => setJoining(null)}><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4">
              <p className="font-sans text-[13px] text-dp-on-surface-variant leading-relaxed">
                {t('pool.joinBlurb').replace('{pool}',
                  isUrdu && joining.name_ur ? joining.name_ur : joining.name)}
              </p>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.announceTitle')}
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  {([
                    [true, 'pool.recurringMonthly'],
                    [false, 'pool.oneTime'],
                  ] as const).map(([val, lbl]) => (
                    <button key={String(val)} type="button"
                      onClick={() => setForm({ ...form, recurring: val })}
                      className={`px-3.5 py-2.5 rounded-lg border-2 font-sans text-[13px] font-semibold transition-colors ${
                        form.recurring === val
                          ? 'border-dp-secondary bg-dp-secondary/5 text-dp-primary'
                          : 'border-dp-outline-variant text-dp-on-surface-variant'}`}>
                      {t(lbl)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.monthlyAmount')}
                </label>
                <input type="number" min={joining.min_share} step={100}
                  value={form.monthly_amount}
                  onChange={(e) => setForm({ ...form, monthly_amount: Number(e.target.value) })}
                  className="w-full border-2 border-dp-outline-variant rounded-lg px-3 py-2.5 font-heading text-[18px] font-bold text-dp-primary focus:border-dp-secondary outline-none" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">
                  {t('pool.minimumIs').replace('{amt}', fmt(joining.min_share))}
                </p>

                <div className="flex flex-wrap gap-2 mt-2.5">
                  {[1000, 2000, 3000, 5000].filter((v) => v >= joining.min_share).map((v) => (
                    <button key={v} type="button"
                      onClick={() => setForm({ ...form, monthly_amount: v })}
                      className={`font-sans text-[12.5px] font-bold px-3 py-1.5 rounded-lg border transition-colors ${
                        form.monthly_amount === v
                          ? 'bg-dp-primary text-white border-dp-primary'
                          : 'border-dp-outline-variant text-dp-on-surface hover:border-dp-secondary'}`}>
                      {fmt(v)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Zakat is deliberately not an option. It needs tamleek —
                  ownership handed to a poor person — so it cannot sit in a
                  pool that pays a school directly. */}
              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.fundedBy')}
                </label>
                <select value={form.funded_by}
                  onChange={(e) => setForm({ ...form, funded_by: e.target.value })}
                  className="w-full border border-dp-outline-variant rounded-lg px-3 py-2.5 font-sans text-[13.5px] focus:border-dp-secondary outline-none">
                  <option value="sadqa">{t('pool.fundedBy.sadqa')}</option>
                  <option value="general">{t('pool.fundedBy.general')}</option>
                </select>
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">
                  {t('pool.noZakat')}
                </p>
              </div>

              {/* Opt-in, off by default. A pledge is never named here — only
                  a donor who has actually paid, and only if they ticked
                  this. */}
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input type="checkbox" checked={form.show_name_publicly}
                  onChange={(e) => setForm({ ...form, show_name_publicly: e.target.checked })}
                  className="w-4 h-4 accent-[color:var(--dp-secondary)] mt-0.5" />
                <span>
                  <span className="block font-sans text-[13px] text-dp-on-surface">
                    {t('pool.showNamePublicly')}
                  </span>
                  <span className="block font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                    {t('pool.showNamePubliclyHint')}
                  </span>
                </span>
              </label>

              <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3">
                <p className="font-sans text-[12.5px] text-dp-on-surface leading-relaxed">
                  {t('pool.announceTerms')}
                </p>
              </div>

              <div className="flex gap-2.5 pt-1">
                <button onClick={submitJoin} disabled={busy}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('common.saving') : t('pool.confirmAnnounce')}
                </button>
                <button onClick={() => setJoining(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] text-dp-on-surface">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Change my own amount ───────────────────────────────────────── */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('pool.changeTitle')}</h3>
              <button onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <input type="number" min={100} step={100} value={newAmount}
                onChange={(e) => setNewAmount(Number(e.target.value))}
                className="w-full border-2 border-dp-outline-variant rounded-lg px-3 py-2.5 font-heading text-[18px] font-bold text-dp-primary focus:border-dp-secondary outline-none" />
              <div className="flex gap-2.5">
                <button onClick={submitChange} disabled={busy}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('common.saving') : t('common.save')}
                </button>
                <button onClick={() => setEditing(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] text-dp-on-surface">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
