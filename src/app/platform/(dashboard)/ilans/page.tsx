'use client'

import { useEffect, useState, useCallback } from 'react'
import { Megaphone, CheckCircle2, XCircle, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface PendingIlan {
  id: string; placement: string; title_ur: string; body_ur: string; price_pkr: number
  starts_at: string; ends_at: string; target_tenant_ids: string[]; contact_mobile: string | null
}
interface RateCard { id: string; placement: string; price_per_village_per_day_pkr: number; min_hours: number; max_days: number; is_active: boolean }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function PlatformIlansPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<PendingIlan[]>([])
  const [cashHeld, setCashHeld] = useState(0)
  const [rateCards, setRateCards] = useState<RateCard[]>([])
  const [settleAmount, setSettleAmount] = useState('')
  const [settleNote, setSettleNote] = useState('')
  const [settling, setSettling] = useState(false)
  const [actionId, setActionId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [{ data: p }, { data: held }, { data: rc }] = await Promise.all([
      supabase.from('commercial_ilans').select('id, placement, title_ur, body_ur, price_pkr, starts_at, ends_at, target_tenant_ids, contact_mobile')
        .eq('status', 'pending_approval').order('created_at', { ascending: true }),
      supabase.rpc('my_ilan_cash_held'),
      supabase.from('ilan_rate_cards').select('id, placement, price_per_village_per_day_pkr, min_hours, max_days, is_active').order('placement'),
    ])
    setPending((p ?? []) as PendingIlan[])
    setCashHeld((held as number) ?? 0)
    setRateCards((rc ?? []) as RateCard[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const approve = async (id: string) => {
    setActionId(id)
    const { error } = await supabase.rpc('platform_approve_ilan', { p_ilan_id: id })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Approved — marked as cash in your hand.')
    load()
  }
  const reject = async (id: string) => {
    const reason = window.prompt('Reason for rejecting this ilan:') ?? ''
    setActionId(id)
    const { error } = await supabase.rpc('platform_reject_ilan', { p_ilan_id: id, p_reason: reason || null })
    setActionId(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Rejected.')
    load()
  }
  const settle = async () => {
    const amount = Number(settleAmount)
    if (!amount || amount <= 0) { toast.error('Enter the amount you are handing in.'); return }
    setSettling(true)
    const { error } = await supabase.rpc('record_ilan_cash_settlement', { p_amount_pkr: amount, p_note: settleNote || null })
    setSettling(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Recorded.')
    setSettleAmount(''); setSettleNote('')
    load()
  }
  const updateRateCard = async (rc: RateCard, field: 'price_per_village_per_day_pkr' | 'min_hours' | 'max_days', value: number) => {
    const { error } = await supabase.from('ilan_rate_cards').update({ [field]: value }).eq('id', rc.id)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-[22px] font-bold text-dp-on-surface flex items-center gap-2"><Megaphone size={20} /> Commercial ilan approvals</h1>
        <p className="text-dp-on-surface-variant text-[13.5px] font-sans mt-0.5">Approving an ilan marks you as holding its price in cash until you settle it below.</p>
      </div>

      <div className="bg-white rounded-xl border border-dp-outline-variant p-5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Wallet size={18} className="text-dp-primary" />
          <span className="font-sans text-[14px] text-dp-on-surface-variant">Cash you are currently holding:</span>
          <span className="font-sans text-[18px] font-bold text-dp-on-surface">₨{fmt(cashHeld)}</span>
        </div>
        <div className="flex items-center gap-2">
          <input value={settleAmount} onChange={(e) => setSettleAmount(e.target.value)} type="number" placeholder="Amount handed in (₨)" className="w-40 px-3 py-2 border-2 border-dp-outline-variant rounded-lg font-sans text-[13.5px]" />
          <input value={settleNote} onChange={(e) => setSettleNote(e.target.value)} placeholder="Note (optional)" className="w-40 px-3 py-2 border-2 border-dp-outline-variant rounded-lg font-sans text-[13.5px]" />
          <button onClick={settle} disabled={settling} className="px-3 py-2 bg-dp-primary text-white rounded-lg font-sans text-[13px] font-bold cursor-pointer disabled:opacity-50">Hand in cash</button>
        </div>
      </div>

      <div>
        <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-2">Pending approval</h2>
        {pending.length === 0 ? (
          <p className="text-dp-on-surface-variant text-[13.5px] font-sans">Nothing waiting.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((ilan) => (
              <div key={ilan.id} className="bg-white rounded-lg border border-dp-outline-variant p-4 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-sans font-bold text-[14.5px]" dir="rtl">{ilan.title_ur}</p>
                  <p className="font-sans text-[13px] text-dp-on-surface-variant mt-0.5" dir="rtl">{ilan.body_ur}</p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">
                    {ilan.placement} · {ilan.target_tenant_ids.length} village(s) · ₨{fmt(ilan.price_pkr)} · {new Date(ilan.starts_at).toLocaleString()} → {new Date(ilan.ends_at).toLocaleString()}
                    {ilan.contact_mobile ? ` · ${ilan.contact_mobile}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => reject(ilan.id)} disabled={actionId === ilan.id} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dp-outline-variant text-dp-error font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <XCircle size={14} /> Reject
                  </button>
                  <button onClick={() => approve(ilan.id)} disabled={actionId === ilan.id} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-dp-primary text-white font-sans text-[12.5px] font-semibold cursor-pointer disabled:opacity-50">
                    <CheckCircle2 size={14} /> Approve &amp; collect cash
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-2">Rate card</h2>
        <div className="bg-white rounded-xl border border-dp-outline-variant divide-y divide-dp-outline-variant">
          {rateCards.map((rc) => (
            <div key={rc.id} className="p-4 flex items-center gap-4 flex-wrap">
              <span className="font-sans font-bold text-[13.5px] w-20 capitalize">{rc.placement}</span>
              <label className="flex items-center gap-1.5 text-[12.5px] font-sans text-dp-on-surface-variant">
                ₨/village/day
                <input type="number" defaultValue={rc.price_per_village_per_day_pkr} onBlur={(e) => updateRateCard(rc, 'price_per_village_per_day_pkr', Number(e.target.value))} className="w-24 px-2 py-1 border border-dp-outline-variant rounded-lg font-sans text-[13px]" />
              </label>
              <label className="flex items-center gap-1.5 text-[12.5px] font-sans text-dp-on-surface-variant">
                min hours
                <input type="number" defaultValue={rc.min_hours} onBlur={(e) => updateRateCard(rc, 'min_hours', Number(e.target.value))} className="w-16 px-2 py-1 border border-dp-outline-variant rounded-lg font-sans text-[13px]" />
              </label>
              <label className="flex items-center gap-1.5 text-[12.5px] font-sans text-dp-on-surface-variant">
                max days
                <input type="number" defaultValue={rc.max_days} onBlur={(e) => updateRateCard(rc, 'max_days', Number(e.target.value))} className="w-16 px-2 py-1 border border-dp-outline-variant rounded-lg font-sans text-[13px]" />
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
