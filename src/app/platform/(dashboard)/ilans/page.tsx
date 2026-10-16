'use client'

import { useEffect, useState, useCallback } from 'react'
import { Megaphone } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface AllIlan {
  id: string; placement: string; title_ur: string; status: string; price_pkr: number
  starts_at: string; ends_at: string; target_tenant_ids: string[]; is_auto_generated: boolean
}
interface RateCard { id: string; placement: string; price_per_village_per_day_pkr: number; min_hours: number; max_days: number; is_active: boolean }

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

const statusColors: Record<string, string> = {
  pending_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-600',
}

export default function PlatformIlansPage() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [recent, setRecent] = useState<AllIlan[]>([])
  const [rateCards, setRateCards] = useState<RateCard[]>([])

  const load = useCallback(async () => {
    const [{ data: r }, { data: rc }] = await Promise.all([
      supabase.from('commercial_ilans').select('id, placement, title_ur, status, price_pkr, starts_at, ends_at, target_tenant_ids, is_auto_generated')
        .order('created_at', { ascending: false }).limit(50),
      supabase.from('ilan_rate_cards').select('id, placement, price_per_village_per_day_pkr, min_hours, max_days, is_active').order('placement'),
    ])
    setRecent((r ?? []) as AllIlan[])
    setRateCards((rc ?? []) as RateCard[])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const updateRateCard = async (rc: RateCard, field: 'price_per_village_per_day_pkr' | 'min_hours' | 'max_days', value: number) => {
    const { error } = await supabase.from('ilan_rate_cards').update({ [field]: value }).eq('id', rc.id)
    if (error) { toast.error(friendlyError(error)); return }
    load()
  }

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-[22px] font-bold text-dp-on-surface flex items-center gap-2"><Megaphone size={20} /> Commercial ilans</h1>
        <p className="text-dp-on-surface-variant text-[13.5px] font-sans mt-0.5">
          Approval and cash collection now happen in each village's own admin panel — this is a cross-tenant overview. The rate card below is still platform-controlled, so a village-day means the same price everywhere.
        </p>
      </div>

      <div>
        <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-2">Rate card</h2>
        <div className="bg-white rounded-xl border border-dp-outline-variant divide-y divide-dp-outline-variant">
          {rateCards.map((rc) => (
            <div key={rc.id} className="p-4 flex items-center gap-4 flex-wrap">
              <span className="font-sans font-bold text-[13.5px] w-24 capitalize">{rc.placement.replace('_', ' ')}</span>
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
              {rc.placement === 'auto_trip' && <span className="text-[11.5px] text-dp-on-surface-variant">(flat fee per post, not multiplied by villages/days)</span>}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="font-heading text-[16px] font-bold text-dp-on-surface mb-2">Recent across all villages</h2>
        {recent.length === 0 ? (
          <p className="text-dp-on-surface-variant text-[13.5px] font-sans">Nothing yet.</p>
        ) : (
          <div className="bg-white rounded-xl border border-dp-outline-variant divide-y divide-dp-outline-variant">
            {recent.map((ilan) => (
              <div key={ilan.id} className="p-3.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-sans text-[13.5px] font-semibold" dir="rtl">{ilan.title_ur}</p>
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">
                    {ilan.placement.replace('_', ' ')} {ilan.is_auto_generated && '· auto'} · {ilan.target_tenant_ids.length} village(s) · ₨{fmt(ilan.price_pkr)}
                  </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${statusColors[ilan.status] ?? 'bg-gray-100 text-gray-600'}`}>{ilan.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
