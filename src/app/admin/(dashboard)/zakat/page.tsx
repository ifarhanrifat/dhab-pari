'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { Scale, Plus, X, Lock, Calculator, HandCoins, FileText, AlertTriangle } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

/**
 * Zakat rounds.
 *
 * The committee's own complaint was that zakat reaches one visible needy
 * person over and over while others get nothing. The fix here is to take the
 * choice away from the donor completely: donors fund a pool, and a verified
 * register splits it by a rule fixed before collection starts.
 *
 * "Before collection starts" is the whole transparency mechanism, which is
 * why the formula fields lock the moment the round is frozen. A rule written
 * after the total is known can be tuned to favour somebody; a rule written
 * before it cannot, and everyone can see that it wasn't.
 */

interface Round {
  id: string; name: string; name_ur: string | null; fund_type: string
  base_per_household: number; per_dependant_increment: number; formula_note: string | null
  opened_at: string; frozen_at: string | null; distribution_date: string | null
  closed_at: string | null; status: string
  collected_pkr: number; distributed_pkr: number; household_count: number
}

interface Beneficiary {
  id: string; code: string; household_size: number; dependants: number
  asnaf_category: string; amount_pkr: number; status: string
  method: string | null; receipt_no: string | null; paid_at: string | null
}

const fmt = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })

export default function ZakatPage() {
  const { t } = useLocale()
  const supabase = createClient()

  const [rounds, setRounds] = useState<Round[]>([])
  const [active, setActive] = useState<Round | null>(null)
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([])
  const [balances, setBalances] = useState<{ zakat: number; ushr: number }>({ zakat: 0, ushr: 0 })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [payTarget, setPayTarget] = useState<Beneficiary | null>(null)
  const [payForm, setPayForm] = useState({ method: 'cash', acknowledgement: 'thumbprint', ref: '', note: '' })

  const [newRound, setNewRound] = useState({
    name: '', name_ur: '', fund_type: 'zakat',
    base_per_household: 1, per_dependant_increment: 0,
    formula_note: '', distribution_date: '',
  })

  const load = useCallback(async () => {
    const [{ data: rs }, { data: zb }, { data: ub }] = await Promise.all([
      supabase.from('zakat_rounds').select('*').order('opened_at', { ascending: false }),
      supabase.rpc('fund_balance', { p_fund_type: 'zakat' }),
      supabase.rpc('fund_balance', { p_fund_type: 'ushr' }),
    ])
    const list = (rs ?? []) as Round[]
    setRounds(list)
    setBalances({ zakat: Number(zb ?? 0), ushr: Number(ub ?? 0) })
    const current = list.find((r) => r.status !== 'closed' && r.status !== 'cancelled') ?? list[0] ?? null
    setActive(current)
    if (current) {
      const { data: bs } = await supabase.from('zakat_round_beneficiaries')
        .select('*').eq('round_id', current.id).order('code')
      setBeneficiaries((bs ?? []) as Beneficiary[])
    } else {
      setBeneficiaries([])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const createRound = async () => {
    if (!newRound.name.trim()) { toast.error(t('zk.err.name')); return }
    setBusy(true)
    const { error } = await supabase.from('zakat_rounds').insert({
      name: newRound.name.trim(), name_ur: newRound.name_ur || null,
      fund_type: newRound.fund_type,
      base_per_household: newRound.base_per_household,
      per_dependant_increment: newRound.per_dependant_increment,
      formula_note: newRound.formula_note || null,
      distribution_date: newRound.distribution_date || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('zk.ok.opened'))
    setShowNew(false)
    setNewRound({ name: '', name_ur: '', fund_type: 'zakat', base_per_household: 1, per_dependant_increment: 0, formula_note: '', distribution_date: '' })
    load()
  }

  const runStep = async (fn: string, okKey: string) => {
    if (!active) return
    setBusy(true)
    const { data, error } = await supabase.rpc(fn, { p_round_id: active.id })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const d = data as Record<string, number>
    toast.success(`${t(okKey)} ${d?.households ?? d?.allocated ? fmt(d.households ?? d.allocated) : ''}`.trim())
    load()
  }

  const disburse = async () => {
    if (!payTarget) return
    setBusy(true)
    const { data, error } = await supabase.rpc('zakat_disburse', {
      p_beneficiary_id: payTarget.id,
      p_method: payForm.method,
      p_acknowledgement: payForm.acknowledgement,
      p_acknowledgement_ref: payForm.ref || null,
      p_note: payForm.note || null,
    })
    setBusy(false)
    if (error) { toast.error(friendlyError(error)); return }
    const d = data as { receipt_no: string }
    toast.success(`${t('zk.ok.paid')} ${d.receipt_no}`)
    setPayTarget(null)
    setPayForm({ method: 'cash', acknowledgement: 'thumbprint', ref: '', note: '' })
    load()
  }

  const paidCount = beneficiaries.filter((b) => b.status === 'paid').length
  const allocated = beneficiaries.reduce((s, b) => s + Number(b.amount_pkr || 0), 0)
  const balance = active?.fund_type === 'ushr' ? balances.ushr : balances.zakat
  const frozen = !!active?.frozen_at

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5">
            <Scale size={26} className="text-dp-secondary" /> {t('zk.title')}
          </h1>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('zk.blurb')}</p>
        </div>
        <button onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold hover:bg-dp-primary transition-all cursor-pointer">
          <Plus size={16} /> {t('zk.newRound')}
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('zk.card.zakatFund')}</p>
          <p className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(balances.zakat)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('zk.card.ushrFund')}</p>
          <p className="font-heading text-[22px] font-bold text-dp-primary">Rs {fmt(balances.ushr)}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('zk.card.households')}</p>
          <p className="font-heading text-[22px] font-bold text-dp-primary">{active?.household_count ?? 0}</p>
        </div>
        <div className="bg-white border border-dp-outline-variant rounded-lg px-4 py-3">
          <p className="font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('zk.card.paid')}</p>
          <p className="font-heading text-[22px] font-bold text-dp-primary">{paidCount} / {beneficiaries.length}</p>
        </div>
      </div>

      {loading && <p className="font-sans text-dp-on-surface-variant">{t('action.loading')}</p>}

      {!loading && !active && (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-8 text-center">
          <p className="font-sans text-[14px] text-dp-on-surface-variant">{t('zk.noRounds')}</p>
        </div>
      )}

      {!loading && active && (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden mb-5">
          <div className="px-5 py-4 border-b border-dp-outline-variant">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-heading text-[20px] font-bold text-dp-primary">{active.name}</h2>
                <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">
                  {t(`zk.status.${active.status}`)} · {t('zk.fund')} {active.fund_type.toUpperCase()}
                  {active.distribution_date && ` · ${t('zk.distributionOn')} ${new Date(active.distribution_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {active.status === 'open' && (
                  <button disabled={busy} onClick={() => runStep('zakat_freeze_round', 'zk.ok.frozen')}
                    className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    <Lock size={14} /> {t('zk.freeze')}
                  </button>
                )}
                {['frozen', 'distributing'].includes(active.status) && (
                  <button disabled={busy} onClick={() => runStep('zakat_compute_round', 'zk.ok.computed')}
                    className="flex items-center gap-1.5 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                    <Calculator size={14} /> {t('zk.compute')}
                  </button>
                )}
              </div>
            </div>

            {/* The formula, stated where everyone can read it. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 bg-dp-surface-container-low rounded-lg px-3.5 py-2.5">
              <span className="font-sans text-[12px] font-bold uppercase tracking-[0.06em] text-dp-outline">{t('zk.formula')}</span>
              <span className="font-sans text-[13px]">{t('zk.base')}: <strong>{active.base_per_household}</strong></span>
              <span className="font-sans text-[13px]">{t('zk.perDependant')}: <strong>{active.per_dependant_increment}</strong></span>
              {frozen && (
                <span className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-on-surface-variant">
                  <Lock size={12} /> {t('zk.formulaLocked')}
                </span>
              )}
            </div>
            {active.formula_note && (
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-2 italic">{active.formula_note}</p>
            )}

            {active.status === 'distributing' && allocated > balance + 1 && (
              <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3.5 py-2.5">
                <AlertTriangle size={15} className="text-dp-error shrink-0 mt-0.5" />
                <p className="font-sans text-[12.5px] text-dp-error font-semibold">{t('zk.warn.overAllocated')}</p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-dp-outline-variant">
            <div className="px-5 py-3">
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('zk.collected')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(active.collected_pkr)}</p>
            </div>
            <div className="px-5 py-3">
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('zk.allocated')}</p>
              <p className="font-heading text-[20px] font-bold text-dp-primary">Rs {fmt(allocated)}</p>
            </div>
            <div className="px-5 py-3">
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{t('zk.distributed')}</p>
              <p className="font-heading text-[20px] font-bold text-emerald-700">Rs {fmt(active.distributed_pkr)}</p>
            </div>
          </div>
        </div>
      )}

      {/* ── The distribution list ───────────────────────────────────────── */}
      {!loading && active && beneficiaries.length > 0 && (
        <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
          <div className="px-5 py-3 border-b border-dp-outline-variant flex items-center gap-2">
            <FileText size={15} className="text-dp-on-surface-variant" />
            <h3 className="font-sans text-[14px] font-bold text-dp-on-surface">{t('zk.list')}</h3>
            <span className="font-sans text-[12px] text-dp-on-surface-variant ms-auto">{t('zk.codesOnly')}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="bg-dp-surface-container-low text-dp-outline text-[13px] font-sans font-bold tracking-[0.05em]">
                  <th className="p-3 text-start">{t('nr.col.code')}</th>
                  <th className="p-3 text-start">{t('nr.col.category')}</th>
                  <th className="p-3 text-center">{t('nr.col.size')}</th>
                  <th className="p-3 text-center">{t('nr.col.dependants')}</th>
                  <th className="p-3 text-end">{t('zk.col.share')}</th>
                  <th className="p-3 text-start">{t('nr.col.status')}</th>
                  <th className="p-3 text-end">{t('nr.col.action')}</th>
                </tr>
              </thead>
              <tbody className="font-sans text-[14px]">
                {beneficiaries.map((b, i) => (
                  <tr key={b.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container/30' : ''}`}>
                    <td className="p-3 border-b border-dp-outline-variant font-mono text-[12.5px] font-semibold">{b.code}</td>
                    <td className="p-3 border-b border-dp-outline-variant">{t(`nr.asnaf.${b.asnaf_category}`)}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center tabular-nums">{b.household_size}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-center tabular-nums">{b.dependants}</td>
                    <td className="p-3 border-b border-dp-outline-variant text-end tabular-nums font-semibold">Rs {fmt(b.amount_pkr)}</td>
                    <td className="p-3 border-b border-dp-outline-variant">
                      {b.status === 'paid' ? (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold">
                          {t('zk.paidWith')} {b.receipt_no}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold">{t(`zk.bstatus.${b.status}`)}</span>
                      )}
                    </td>
                    <td className="p-3 border-b border-dp-outline-variant text-end">
                      {b.status === 'pending' && b.amount_pkr > 0 && (
                        <button onClick={() => setPayTarget(b)}
                          className="flex items-center gap-1.5 ms-auto px-3 py-1.5 border border-dp-secondary text-dp-secondary rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-secondary hover:text-white transition-all cursor-pointer whitespace-nowrap">
                          <HandCoins size={14} /> {t('zk.handOver')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Open a round ────────────────────────────────────────────────── */}
      {showNew && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowNew(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('zk.newRound')}</h2>
              <button onClick={() => setShowNew(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <p className="font-sans text-[12.5px] text-dp-on-surface-variant bg-dp-surface-container-low rounded-lg px-3 py-2.5 mb-4">
              {t('zk.formulaFirstNotice')}
            </p>

            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.name')}</label>
                  <input value={newRound.name} onChange={(e) => setNewRound({ ...newRound, name: e.target.value })}
                    placeholder="Ramadan 1447" className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('g.nameUrdu')}</label>
                  <input value={newRound.name_ur} onChange={(e) => setNewRound({ ...newRound, name_ur: e.target.value })}
                    className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
                </div>
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.fund')}</label>
                <select value={newRound.fund_type} onChange={(e) => setNewRound({ ...newRound, fund_type: e.target.value })} className="input-field">
                  <option value="zakat">{t('zk.fund.zakat')}</option>
                  <option value="ushr">{t('zk.fund.ushr')}</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.base')}</label>
                  <input type="number" min={0} step="0.1" value={newRound.base_per_household}
                    onChange={(e) => setNewRound({ ...newRound, base_per_household: +e.target.value })} className="input-field" />
                </div>
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.increment')}</label>
                  <input type="number" min={0} step="0.1" value={newRound.per_dependant_increment}
                    onChange={(e) => setNewRound({ ...newRound, per_dependant_increment: +e.target.value })} className="input-field" />
                </div>
              </div>
              <p className="font-sans text-[11.5px] text-dp-on-surface-variant -mt-1">{t('zk.f.formulaHint')}</p>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.distributionDate')}</label>
                <input type="date" value={newRound.distribution_date}
                  onChange={(e) => setNewRound({ ...newRound, distribution_date: e.target.value })} className="input-field" />
              </div>

              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.f.note')}</label>
                <textarea value={newRound.formula_note} onChange={(e) => setNewRound({ ...newRound, formula_note: e.target.value })}
                  rows={2} placeholder={t('zk.f.notePlaceholder')} className="input-field resize-none" />
              </div>

              <button disabled={busy} onClick={createRound}
                className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
                {busy ? t('action.saving') : t('zk.openRound')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hand over ───────────────────────────────────────────────────── */}
      {payTarget && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setPayTarget(null)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('zk.handOverTitle')}</h2>
              <button onClick={() => setPayTarget(null)} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
            </div>

            <div className="bg-dp-surface-container-low rounded-lg px-3.5 py-3 mb-4">
              <p className="font-mono text-[13px] font-bold">{payTarget.code}</p>
              <p className="font-heading text-[22px] font-bold text-dp-primary mt-0.5">Rs {fmt(payTarget.amount_pkr)}</p>
            </div>

            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mb-3">{t('zk.tamleekNotice')}</p>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.paymentMethod')}</label>
            <select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} className="input-field mb-3">
              <option value="cash">{t('w.cash')}</option>
              <option value="bank">{t('a.bank')}</option>
              <option value="jazzcash">{t('w.jazzcash')}</option>
              <option value="easypaisa">{t('w.easypaisa')}</option>
              <option value="in_kind">{t('zk.inKind')}</option>
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.acknowledgement')}</label>
            <select value={payForm.acknowledgement} onChange={(e) => setPayForm({ ...payForm, acknowledgement: e.target.value })} className="input-field mb-3">
              <option value="thumbprint">{t('zk.ack.thumbprint')}</option>
              <option value="signature">{t('zk.ack.signature')}</option>
              <option value="witness">{t('zk.ack.witness')}</option>
              <option value="transfer_ref">{t('zk.ack.transferRef')}</option>
            </select>

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('zk.ackRef')}</label>
            <input value={payForm.ref} onChange={(e) => setPayForm({ ...payForm, ref: e.target.value })} className="input-field mb-3" />

            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.notesOptional')}</label>
            <textarea value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })}
              rows={2} className="input-field resize-none mb-4" />

            <button disabled={busy} onClick={disburse}
              className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
              <HandCoins size={16} /> {busy ? t('action.saving') : t('zk.recordHandover')}
            </button>
          </div>
        </div>
      )}

      {/* ── Past rounds ─────────────────────────────────────────────────── */}
      {!loading && rounds.length > 1 && (
        <div className="mt-5 bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
          <div className="px-5 py-3 border-b border-dp-outline-variant">
            <h3 className="font-sans text-[14px] font-bold text-dp-on-surface">{t('zk.pastRounds')}</h3>
          </div>
          <div className="divide-y divide-dp-outline-variant">
            {rounds.filter((r) => r.id !== active?.id).map((r) => (
              <div key={r.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{r.name}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant">
                    {t(`zk.status.${r.status}`)} · {r.household_count} {t('zk.households')} · {t('zk.base')} {r.base_per_household} / {t('zk.perDependant')} {r.per_dependant_increment}
                  </p>
                </div>
                <p className="font-sans text-[14px] font-bold text-dp-primary">Rs {fmt(r.distributed_pkr)}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
