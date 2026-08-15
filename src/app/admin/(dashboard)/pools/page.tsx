'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  Users, Phone, AlertTriangle, Check, X, Wallet, HandCoins, RotateCcw, Info, Pencil, Clock,
} from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Mushtarka Kafalat, from the donor accountant's desk.
 *
 * Three questions, in the order they matter at month end:
 *
 *   Who stopped paying, and what is their phone number? A shortfall is almost
 *   always four people who forgot, not a collapse in support, so the names and
 *   numbers come before the total — one round of phone calls usually closes
 *   more of the gap than any committee decision does.
 *
 *   What is still short after those calls? That is what the committee has to
 *   decide about.
 *
 *   Can the committee actually afford to cover it? Shown as unrestricted money
 *   — cash and bank less everything already earmarked — rather than a bank
 *   balance that includes other people's restricted funds.
 *
 * Covering is one month only. It settles that month and expires with it; the
 * pool keeps asking for the donors it still needs, and the appeal goes back out
 * the next day. Nothing here creates a standing arrangement.
 */

interface Position {
  pool_id: string; code: string; name: string; name_ur: string | null
  required: number; committed: number; received_this_month: number
  committee_covered_this_month: number; donors: number; coverage_percent: number
  gap: number; suggested_share: number; min_share: number; donors_needed: number
  reserve_months: number; reserve_target_months: number; is_short: boolean
}

interface ShortMonth {
  pool_month_id: string; pool_id: string; pool_code: string; pool: string; month: string
  required: number; received: number; shortfall: number; covered: number
  remaining: number; donors_active: number; donors_needed: number; status: string
}

interface Lapsed {
  commitment_id: string; pool_code: string; pool: string; name: string
  phone: string | null; amount: number; since: string
}

interface Cover {
  month: string; pool_code: string; pool: string; amount: number
  voucher_no: string | null; at: string; by: string | null
}

interface Queue {
  unrestricted_available: number
  months: ShortMonth[]
  lapsed: Lapsed[]
  covers: Cover[]
}

interface Announcement {
  id: string; pool_code: string; pool: string; donor_name: string | null; donor_phone: string | null
  amount: number; is_one_time: boolean; month: string; proof_url: string | null; announced_at: string
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
const monthName = (d: string) =>
  new Date(d).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

export default function AdminPoolsPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [pools, setPools] = useState<Position[]>([])
  const [queue, setQueue] = useState<Queue | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [covering, setCovering] = useState<ShortMonth | null>(null)
  const [coverAmount, setCoverAmount] = useState(0)
  const [coverNote, setCoverNote] = useState('')

  // Editing the one number that is meant to move. There is no "new pool"
  // here any more — Kafalat, Wazifa and the shared Sadqa upkeep pool are
  // fixed, one each, created by their own migrations; a screen that let an
  // admin spin up arbitrary ad-hoc pools was itself part of the manual
  // system this page has moved away from.
  const [editing, setEditing] = useState<Position | null>(null)
  const [editForm, setEditForm] = useState({
    name: '', suggested_share: 0, min_share: 0, reserve_months: 0,
    manual_target: '' as string, clear_manual: false,
  })

  // Receiving cash from someone who never touched the portal at all now
  // lives in the one general "Add Donor" screen (/admin/donors), not here —
  // the same search-by-name/mobile-first, create-only-if-new step, and the
  // same posting path, but through the one place staff already record every
  // other kind of donation, instead of a second screen with the same job.

  // What donors have told us they are sending, not yet matched against the
  // bank statement. This is the accountant's actual daily task now — one tap
  // to confirm turns it into a real donation, ledger entry and (for Kafalat)
  // a credit against the measuring account, all in one place.
  const [announcements, setAnnouncements] = useState<Announcement[]>([])

  const load = useCallback(async () => {
    // Kafalat is deliberately excluded — its own collections screen now
    // lives inside /admin/kafalat, scoped to just that one pool, instead of
    // being split across two pages.
    const { data: list } = await supabase.from('support_pools').select('id, code').eq('is_active', true).neq('code', 'POOL-KFL')
    const ids = (list ?? []).map((p: { id: string }) => p.id)
    const positions = await Promise.all(
      ids.map((id) => supabase.rpc('pool_position', { p_pool_id: id })),
    )
    const { data: q } = await supabase.rpc('pool_shortfall_queue')
    const { data: ann } = await supabase.rpc('pool_announcement_queue')
    setPools(positions.map((r) => r.data as Position).filter(Boolean))
    const qData = q as Queue | null
    setQueue(qData ? {
      ...qData,
      months: qData.months.filter((m) => m.pool_code !== 'POOL-KFL'),
      lapsed: qData.lapsed.filter((l) => l.pool_code !== 'POOL-KFL'),
      covers: qData.covers.filter((c) => c.pool_code !== 'POOL-KFL'),
    } : null)
    setAnnouncements(((ann ?? []) as Announcement[]).filter((a) => a.pool_code !== 'POOL-KFL'))
    setLoading(false)
  }, [supabase])

  const confirmAnnouncement = async (id: string) => {
    setBusy(true)
    const { error } = await supabase.rpc('pool_confirm_payment', { p_payment_id: id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.confirmed'))
    load()
  }

  const declineAnnouncement = async (id: string) => {
    const reason = prompt(t('pool.declineReasonPrompt'))
    if (!reason) return
    const { error } = await supabase.rpc('pool_decline_announcement', { p_payment_id: id, p_reason: reason })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.ok.declined'))
    load()
  }

  useEffect(() => { load() }, [load])

  const openCover = (m: ShortMonth) => {
    setCoverAmount(m.remaining)
    setCoverNote('')
    setCovering(m)
  }

  const submitCover = async () => {
    if (!covering) return
    setBusy(true)
    const { data, error } = await supabase.rpc('pool_cover_shortfall', {
      p_pool_month_id: covering.pool_month_id,
      p_amount: coverAmount,
      p_note: coverNote || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.covered').replace('{v}', (data as { voucher_no: string })?.voucher_no ?? ''))
    setCovering(null)
    load()
  }

  const openEdit = (p: Position) => {
    setEditForm({
      name: p.name, suggested_share: p.suggested_share, min_share: p.min_share ?? 500,
      reserve_months: p.reserve_target_months ?? 2, manual_target: '', clear_manual: false,
    })
    setEditing(p)
  }

  const saveEdit = async () => {
    if (!editing) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_update', {
      p_pool_id: editing.pool_id,
      p_name: editForm.name || null,
      p_suggested_share: editForm.suggested_share || null,
      p_min_share: editForm.min_share || null,
      p_reserve_months: editForm.reserve_months || null,
      p_manual_monthly_target: editForm.manual_target === '' ? null : Number(editForm.manual_target),
      p_clear_manual_target: editForm.clear_manual,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.saved'))
    setEditing(null)
    load()
  }

  if (loading) {
    return <div className="font-sans text-[14px] text-dp-on-surface-variant">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2.5">
            <Users size={24} /> {t('pool.adminTitle')}
          </h1>
          <p className="font-sans text-[13px] text-dp-on-surface-variant mt-1 max-w-2xl">
            {t('pool.adminBlurb')}
          </p>
        </div>
        {/* The appeal and the month-end close used to be buttons here —
            press one to nudge donors, press the other to work out what came
            in. Both now run on their own (cron: pool-daily-appeal every
            morning, pool-close-month on the 3rd), so there is nothing left
            to press. What is still a real decision for a person — confirming
            an announced payment, covering a shortfall from committee funds —
            stays below. */}
        <div className="flex items-start gap-2 bg-dp-surface-container-low border border-dp-outline-variant rounded-lg px-3.5 py-2.5 max-w-xs">
          <Clock size={15} className="text-dp-secondary shrink-0 mt-0.5" />
          <p className="font-sans text-[12px] text-dp-on-surface-variant leading-relaxed">{t('pool.autoNotice')}</p>
        </div>
      </div>

      {/* ── Where each pool stands ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {pools.map((p) => (
          <div key={p.pool_id} className="bg-white border border-dp-outline-variant rounded-lg p-5">
            <div className="flex items-start justify-between gap-3 mb-3">
              <h3 className="font-heading text-[15px] font-bold text-dp-primary leading-tight">
                {p.name}
              </h3>
              <span className="font-heading text-[15px] font-bold text-dp-secondary tabular-nums shrink-0">
                {p.coverage_percent}%
              </span>
            </div>

            <div className="h-2 rounded-full bg-dp-outline-variant overflow-hidden mb-3">
              <div className="h-full bg-dp-secondary rounded-full"
                style={{ width: `${Math.max(p.coverage_percent, 1)}%` }} />
            </div>

            <div className="grid grid-cols-3 gap-3 mb-3">
              {[
                { v: fmt(p.required), l: t('pool.needed') },
                { v: fmt(p.committed), l: t('pool.pledged') },
                { v: String(p.donors), l: t('pool.donors') },
              ].map((s) => (
                <div key={s.l}>
                  <p className="font-heading text-[17px] font-bold text-dp-primary">{s.v}</p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">{s.l}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 font-sans text-[11.5px] text-dp-on-surface-variant mb-3">
              <span className="flex items-center gap-1.5">
                <Wallet size={12} />
                {t('pool.reserve')
                  .replace('{n}', String(p.reserve_months))
                  .replace('{target}', String(p.reserve_target_months))}
              </span>
              <span>{t('pool.receivedThisMonth').replace('{amt}', fmt(p.received_this_month))}</span>
            </div>

            {p.is_short && (
              <p className="font-sans text-[12px] text-dp-secondary font-semibold mb-3">
                {t('pool.stillNeeds')
                  .replace('{n}', String(p.donors_needed))
                  .replace('{amt}', fmt(p.suggested_share))}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <button onClick={() => openEdit(p)}
                className="font-sans text-[12.5px] font-bold text-dp-on-surface-variant hover:underline flex items-center gap-1.5">
                <Pencil size={13} /> {t('pool.edit')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Announced, awaiting confirmation ─────────────────────────────
          The actual daily task: match each against the bank statement or
          the slip attached, then tap. That single tap is the moment a
          donor's word becomes a real donation, a ledger entry, and — for
          Kafalat — a credit against the measuring account. Nothing here
          moves until that happens. */}
      {announcements.length > 0 && (
        <section>
          <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1 flex items-center gap-2">
            <HandCoins size={18} /> {t('pool.queueTitle')}
          </h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3 max-w-2xl">
            {t('pool.queueBlurb')}
          </p>
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead className="bg-dp-surface-container-low">
                <tr>
                  {['pool.donor', 'pool.phone', 'pool.pool', 'pool.amount', 'pool.month', ''].map((k, i) => (
                    <th key={i} className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide px-4 py-2.5 text-start">
                      {k && t(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {announcements.map((a) => (
                  <tr key={a.id} className="border-t border-dp-outline-variant">
                    <td className="px-4 py-2.5 font-sans text-[13px] text-dp-on-surface font-semibold">
                      {a.donor_name ?? '—'}
                      <span className="block font-sans text-[11px] font-normal text-dp-on-surface-variant">
                        {a.is_one_time ? t('pool.oneTime') : t('pool.recurringMonthly')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-sans text-[13px]">
                      {a.donor_phone ? (
                        <a href={`tel:${a.donor_phone}`} className="text-dp-secondary hover:underline">{a.donor_phone}</a>
                      ) : <span className="text-dp-on-surface-variant">—</span>}
                    </td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">{a.pool}</td>
                    <td className="px-4 py-2.5 font-sans text-[13px] font-semibold text-dp-on-surface">{fmt(a.amount)}</td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">
                      {new Date(a.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3 justify-end">
                        {a.proof_url ? (
                          <a href={a.proof_url} target="_blank" rel="noreferrer"
                            className="font-sans text-[12px] font-bold text-dp-secondary hover:underline">
                            {t('pool.viewProof')}
                          </a>
                        ) : (
                          <span className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('pool.noProofYet')}</span>
                        )}
                        <button onClick={() => confirmAnnouncement(a.id)} disabled={busy}
                          className="bg-dp-secondary text-white font-sans text-[12px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-50">
                          {t('pool.confirmThis')}
                        </button>
                        <button onClick={() => declineAnnouncement(a.id)}
                          className="font-sans text-[12px] font-bold text-dp-on-surface-variant hover:underline">
                          {t('pool.declineThis')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Who stopped paying ─────────────────────────────────────────── */}
      {queue && queue.lapsed.length > 0 && (
        <section>
          <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1 flex items-center gap-2">
            <Phone size={18} /> {t('pool.lapsedTitle')}
          </h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3 max-w-2xl">
            {t('pool.lapsedBlurb')}
          </p>
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-x-auto">
            <table className="w-full text-start">
              <thead className="bg-dp-surface-container-low">
                <tr>
                  {['pool.donor', 'pool.phone', 'pool.pool', 'pool.monthly', 'pool.lapsedSince'].map((k) => (
                    <th key={k} className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide px-4 py-2.5 text-start">
                      {t(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queue.lapsed.map((l) => (
                  <tr key={l.commitment_id} className="border-t border-dp-outline-variant">
                    <td className="px-4 py-2.5 font-sans text-[13px] text-dp-on-surface font-semibold">{l.name}</td>
                    <td className="px-4 py-2.5 font-sans text-[13px]">
                      {l.phone ? (
                        <a href={`tel:${l.phone}`} className="text-dp-secondary hover:underline">{l.phone}</a>
                      ) : <span className="text-dp-on-surface-variant">—</span>}
                    </td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">{l.pool}</td>
                    <td className="px-4 py-2.5 font-sans text-[13px] text-dp-on-surface">{fmt(l.amount)}</td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">
                      {new Date(l.since).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Months still short ─────────────────────────────────────────── */}
      {queue && queue.months.length > 0 && (
        <section>
          <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1 flex items-center gap-2">
            <AlertTriangle size={18} /> {t('pool.shortTitle')}
          </h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3 max-w-2xl">
            {t('pool.shortBlurb').replace('{amt}', fmt(queue.unrestricted_available))}
          </p>

          <div className="space-y-3">
            {queue.months.map((m) => (
              <div key={m.pool_month_id}
                className="bg-white border border-dp-outline-variant rounded-lg p-4 flex flex-wrap items-center gap-4">
                <div className="flex-1 min-w-[220px]">
                  <p className="font-heading text-[14px] font-bold text-dp-primary">{m.pool}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">
                    {monthName(m.month)} · {t('pool.neededReceived')
                      .replace('{req}', fmt(m.required)).replace('{recd}', fmt(m.received))}
                  </p>
                </div>

                <div className="text-center">
                  <p className="font-heading text-[19px] font-bold text-dp-secondary">{fmt(m.remaining)}</p>
                  <p className="font-sans text-[11px] text-dp-on-surface-variant">{t('pool.stillShort')}</p>
                </div>

                <button onClick={() => openCover(m)}
                  className="bg-dp-primary text-white font-sans text-[12.5px] font-bold px-4 py-2 rounded-lg hover:opacity-90">
                  {t('pool.coverIt')}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── What the committee has already absorbed ────────────────────── */}
      {queue && queue.covers.length > 0 && (
        <section>
          <h2 className="font-heading text-[17px] font-bold text-dp-primary mb-1 flex items-center gap-2">
            <RotateCcw size={18} /> {t('pool.coversTitle')}
          </h2>
          <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3 max-w-2xl">
            {t('pool.coversBlurb')}
          </p>
          <div className="bg-white border border-dp-outline-variant rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead className="bg-dp-surface-container-low">
                <tr>
                  {['pool.month', 'pool.pool', 'pool.amount', 'pool.voucher', 'pool.confirmedBy'].map((k) => (
                    <th key={k} className="font-sans text-[11.5px] font-bold text-dp-on-surface-variant uppercase tracking-wide px-4 py-2.5 text-start">
                      {t(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {queue.covers.map((c, i) => (
                  <tr key={i} className="border-t border-dp-outline-variant">
                    <td className="px-4 py-2.5 font-sans text-[13px] text-dp-on-surface">{monthName(c.month)}</td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">{c.pool}</td>
                    <td className="px-4 py-2.5 font-sans text-[13px] font-semibold text-dp-on-surface">{fmt(c.amount)}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-dp-secondary">{c.voucher_no ?? '—'}</td>
                    <td className="px-4 py-2.5 font-sans text-[12.5px] text-dp-on-surface-variant">{c.by ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Confirming the cover ───────────────────────────────────────── */}
      {covering && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('pool.coverTitle')}</h3>
              <button onClick={() => setCovering(null)}><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4">
              <p className="font-sans text-[13px] text-dp-on-surface leading-relaxed">
                {t('pool.coverBlurb')
                  .replace('{pool}', covering.pool)
                  .replace('{month}', monthName(covering.month))}
              </p>

              {/* Said plainly, because it is the part that is easy to get
                  wrong: no cash moves today, and this settles one month only. */}
              <div className="flex items-start gap-2 bg-dp-surface-container-low rounded-lg px-3.5 py-3">
                <Info size={15} className="text-dp-secondary shrink-0 mt-0.5" />
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant leading-relaxed">
                  {t('pool.coverExplain')}
                </p>
              </div>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.coverAmount')}
                </label>
                <input type="number" min={1} max={covering.remaining} value={coverAmount}
                  onChange={(e) => setCoverAmount(Number(e.target.value))}
                  className="w-full border-2 border-dp-outline-variant rounded-lg px-3 py-2.5 font-heading text-[18px] font-bold text-dp-primary focus:border-dp-secondary outline-none" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1.5">
                  {t('pool.availableIs').replace('{amt}', fmt(queue?.unrestricted_available ?? 0))}
                </p>
              </div>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.coverNote')}
                </label>
                <textarea value={coverNote} onChange={(e) => setCoverNote(e.target.value)} rows={2}
                  className="w-full border border-dp-outline-variant rounded-lg px-3 py-2 font-sans text-[13px] focus:border-dp-secondary outline-none" />
              </div>

              <div className="flex gap-2.5">
                <button onClick={submitCover} disabled={busy}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2">
                  <Check size={16} /> {busy ? t('common.saving') : t('pool.confirmCover')}
                </button>
                <button onClick={() => setCovering(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] text-dp-on-surface">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Editing a pool ─────────────────────────────────────────────
          The suggested share is the number meant to move: as the pool grows,
          the next person is asked for less. Nothing here can touch what a
          donor has already agreed to — that promise is the whole design. */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('pool.editTitle')}</h3>
              <button onClick={() => setEditing(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">{t('pool.f.name')}</label>
                <input value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="input-field" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">{t('pool.f.suggestedShare')}</label>
                  <input type="number" min={1} value={editForm.suggested_share || ''}
                    onChange={(e) => setEditForm({ ...editForm, suggested_share: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">{t('pool.f.minShare')}</label>
                  <input type="number" min={1} value={editForm.min_share || ''}
                    onChange={(e) => setEditForm({ ...editForm, min_share: +e.target.value })} className="input-field" />
                </div>
              </div>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">{t('pool.f.reserveMonths')}</label>
                <input type="number" min={0} step={0.5} value={editForm.reserve_months || ''}
                  onChange={(e) => setEditForm({ ...editForm, reserve_months: +e.target.value })} className="input-field" />
              </div>

              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">{t('pool.f.manualTarget')}</label>
                <input type="number" min={0} value={editForm.manual_target}
                  disabled={editForm.clear_manual}
                  onChange={(e) => setEditForm({ ...editForm, manual_target: e.target.value })}
                  placeholder={String(editing.required)} className="input-field disabled:opacity-50" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">
                  {t('pool.f.manualTargetHint').replace('{amt}', fmt(editing.required))}
                </p>
                <label className="flex items-center gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" checked={editForm.clear_manual}
                    onChange={(e) => setEditForm({ ...editForm, clear_manual: e.target.checked })}
                    className="w-4 h-4 accent-[color:var(--dp-secondary)]" />
                  <span className="font-sans text-[12.5px] text-dp-on-surface">{t('pool.f.useComputed')}</span>
                </label>
              </div>

              <div className="flex gap-2.5">
                <button onClick={saveEdit} disabled={busy}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('common.saving') : t('common.save')}
                </button>
                <button onClick={() => setEditing(null)}
                  className="px-5 border border-dp-outline-variant rounded-lg font-sans text-[13.5px]">{t('common.cancel')}</button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
