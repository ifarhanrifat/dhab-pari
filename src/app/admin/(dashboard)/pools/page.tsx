'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import {
  Users, Phone, AlertTriangle, Check, X, Wallet, CalendarCheck,
  HandCoins, RotateCcw, Info,
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
  gap: number; suggested_share: number; donors_needed: number
  reserve_months: number; reserve_target_months: number; is_short: boolean
}

interface ShortMonth {
  pool_month_id: string; pool_id: string; pool: string; month: string
  required: number; received: number; shortfall: number; covered: number
  remaining: number; donors_active: number; donors_needed: number; status: string
}

interface Lapsed {
  commitment_id: string; pool: string; name: string
  phone: string | null; amount: number; since: string
}

interface Cover {
  month: string; pool: string; amount: number
  voucher_no: string | null; at: string; by: string | null
}

interface Queue {
  unrestricted_available: number
  months: ShortMonth[]
  lapsed: Lapsed[]
  covers: Cover[]
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

  const [paying, setPaying] = useState<{ pool_id: string; pool: string } | null>(null)
  const [commitments, setCommitments] = useState<{ id: string; donor_name: string; monthly_amount_pkr: number; status: string }[]>([])
  const [payForm, setPayForm] = useState({ commitment_id: '', amount: 0, method: 'cash' })

  const load = useCallback(async () => {
    const { data: list } = await supabase.from('support_pools').select('id').eq('is_active', true)
    const positions = await Promise.all(
      (list ?? []).map((p: { id: string }) => supabase.rpc('pool_position', { p_pool_id: p.id })),
    )
    const { data: q } = await supabase.rpc('pool_shortfall_queue')
    setPools(positions.map((r) => r.data as Position).filter(Boolean))
    setQueue((q ?? null) as Queue | null)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const closeMonth = async () => {
    if (!confirm(t('pool.closeConfirm'))) return
    setBusy(true)
    const { error } = await supabase.rpc('pool_close_all_months')
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.closed'))
    load()
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

  const openPay = async (pool_id: string, pool: string) => {
    const { data } = await supabase.from('pool_commitments')
      .select('id, donor_name, monthly_amount_pkr, status')
      .eq('pool_id', pool_id).in('status', ['active', 'lapsed']).order('donor_name')
    setCommitments((data ?? []) as typeof commitments)
    setPayForm({ commitment_id: '', amount: 0, method: 'cash' })
    setPaying({ pool_id, pool })
  }

  const submitPay = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('pool_record_payment', {
      p_commitment_id: payForm.commitment_id,
      p_amount: payForm.amount,
      p_method: payForm.method,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('pool.paymentRecorded'))
    setPaying(null)
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
        <button onClick={closeMonth} disabled={busy}
          className="bg-dp-primary text-white font-sans text-[13px] font-bold px-4 py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 flex items-center gap-2">
          <CalendarCheck size={16} /> {t('pool.closeMonth')}
        </button>
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

            <button onClick={() => openPay(p.pool_id, p.name)}
              className="font-sans text-[12.5px] font-bold text-dp-secondary hover:underline flex items-center gap-1.5">
              <HandCoins size={14} /> {t('pool.recordPayment')}
            </button>
          </div>
        ))}
      </div>

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

      {/* ── Recording a monthly payment ────────────────────────────────── */}
      {paying && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="bg-dp-primary text-white px-5 py-3.5 flex items-center justify-between">
              <h3 className="font-heading text-[15px] font-bold">{t('pool.recordTitle')}</h3>
              <button onClick={() => setPaying(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                  {t('pool.donor')}
                </label>
                <select value={payForm.commitment_id}
                  onChange={(e) => {
                    const c = commitments.find((x) => x.id === e.target.value)
                    setPayForm({ ...payForm, commitment_id: e.target.value, amount: c?.monthly_amount_pkr ?? 0 })
                  }}
                  className="w-full border border-dp-outline-variant rounded-lg px-3 py-2.5 font-sans text-[13.5px] focus:border-dp-secondary outline-none">
                  <option value="">{t('pool.chooseDonor')}</option>
                  {commitments.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.donor_name} — {fmt(c.monthly_amount_pkr)}
                      {c.status === 'lapsed' ? ` (${t('pool.status.lapsed')})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                    {t('pool.amount')}
                  </label>
                  <input type="number" min={1} value={payForm.amount}
                    onChange={(e) => setPayForm({ ...payForm, amount: Number(e.target.value) })}
                    className="w-full border border-dp-outline-variant rounded-lg px-3 py-2.5 font-sans text-[13.5px] focus:border-dp-secondary outline-none" />
                </div>
                <div>
                  <label className="font-sans text-[12.5px] font-bold text-dp-primary block mb-1.5">
                    {t('pool.method')}
                  </label>
                  <select value={payForm.method}
                    onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
                    className="w-full border border-dp-outline-variant rounded-lg px-3 py-2.5 font-sans text-[13.5px] focus:border-dp-secondary outline-none">
                    <option value="cash">{t('pool.method.cash')}</option>
                    <option value="bank">{t('pool.method.bank')}</option>
                    <option value="jazzcash">JazzCash</option>
                    <option value="easypaisa">EasyPaisa</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2.5">
                <button onClick={submitPay} disabled={busy || !payForm.commitment_id || payForm.amount <= 0}
                  className="flex-1 bg-dp-primary text-white font-sans text-[13.5px] font-bold py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
                  {busy ? t('common.saving') : t('common.save')}
                </button>
                <button onClick={() => setPaying(null)}
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
