'use client'

// Weekend Offers — its own screen, matching the design zip (previously
// embedded on the driver dashboard).
//
// Phase 5: re-skinned to the new Mobility design — same RPCs, the
// fixed-position add modal now uses the shared MobilityBottomSheet,
// reached from the Vehicle tab's settings list.

import { useEffect, useState } from 'react'
import { CalendarClock, PlusCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'

interface WeekendOffer { id: string; city_name: string; city_name_ur: string | null; direction: string; day_of_week: number; seats_total: number; seats_taken: number; fare_per_seat_pkr: number; is_active: boolean }
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const inputCls = 'dp2-input'

function fmt(n: number) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleWeekendPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()

  const [vehicleId, setVehicleId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [vpSaving, setVpSaving] = useState(false)
  const [cities, setCities] = useState<{ id: string; name: string; name_ur: string | null }[]>([])
  const [weekendOffers, setWeekendOffers] = useState<WeekendOffer[]>([])
  const [showAddWeekendOffer, setShowAddWeekendOffer] = useState(false)
  const [weekendForm, setWeekendForm] = useState({ city_id: '', direction: 'to_village', day_of_week: 6, seats_total: 1, fare_per_seat_pkr: 0 })

  const reload = async (id: string) => {
    const { data: wo } = await supabase.rpc('my_weekend_share_offers', { p_vehicle_id: id })
    setWeekendOffers((wo ?? []) as WeekendOffer[])
  }

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id').eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
      if (data) { setVehicleId(data.id); await reload(data.id) }
      setLoading(false)
    })
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const addWeekendOffer = async () => {
    if (!vehicleId || !weekendForm.city_id || !weekendForm.fare_per_seat_pkr) { toast.error(t('vp.fillWeekendFormError')); return }
    setVpSaving(true)
    const { error } = await supabase.from('weekend_share_offers').insert({
      vehicle_id: vehicleId, city_id: weekendForm.city_id, direction: weekendForm.direction,
      day_of_week: weekendForm.day_of_week, seats_total: weekendForm.seats_total, fare_per_seat_pkr: weekendForm.fare_per_seat_pkr,
    })
    setVpSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    setShowAddWeekendOffer(false)
    setWeekendForm({ city_id: '', direction: 'to_village', day_of_week: 6, seats_total: 1, fare_per_seat_pkr: 0 })
    reload(vehicleId)
  }
  const removeWeekendOffer = async (id: string) => {
    if (!vehicleId) return
    await supabase.from('weekend_share_offers').delete().eq('id', id)
    reload(vehicleId)
  }

  if (userLoading || loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-[20px] text-[#005A36] flex items-center gap-2"><CalendarClock size={19} /> {t('vp.weekendOffersHeading')}</h1>
        <button onClick={() => setShowAddWeekendOffer(true)} className="flex items-center gap-1 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer"><PlusCircle size={14} /> {t('action.add')}</button>
      </div>
      {weekendOffers.length === 0 && <p className="font-sans text-[14px] text-[#94a3b8] text-center py-10">{t('vp.noWeekendOffersYet')}</p>}
      <div className="flex flex-col gap-2">
        {weekendOffers.map((o) => (
          <div key={o.id} className="flex items-center justify-between gap-3 bg-white border border-[#e5e2d0] rounded-2xl p-3">
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-semibold text-[#1e293b] truncate">{isUrdu && o.city_name_ur ? o.city_name_ur : o.city_name} · {t(o.direction === 'to_village' ? 'vp.toVillageShort' : 'vp.toCityShort')}</p>
              <p className="font-sans text-[12px] text-[#64748b] mt-0.5">{t(`vp.day.${DAY_KEYS[o.day_of_week]}`)} · <span className="ltr-num">{o.seats_total - o.seats_taken}/{o.seats_total}</span> {t('vp.seatsFreeShortLabel')} · {fmt(o.fare_per_seat_pkr)}</p>
            </div>
            <button onClick={() => removeWeekendOffer(o.id)} className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-[#b91c1c] cursor-pointer"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {showAddWeekendOffer && (
        <MobilityBottomSheet title={t('vp.weekendOffersHeading')} onClose={() => setShowAddWeekendOffer(false)}>
          <div className="flex flex-col gap-3">
            <select value={weekendForm.city_id} onChange={(e) => setWeekendForm({ ...weekendForm, city_id: e.target.value })} className={inputCls}>
              <option value="">{t('vp.pickCityOption')}</option>
              {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_village' })} className="py-2.5 rounded-xl text-[13px] font-sans font-semibold cursor-pointer" style={{ background: weekendForm.direction === 'to_village' ? '#166534' : '#F9F9F6', color: weekendForm.direction === 'to_village' ? '#fff' : '#64748b' }}>{t('vp.toVillageShort')}</button>
              <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_city' })} className="py-2.5 rounded-xl text-[13px] font-sans font-semibold cursor-pointer" style={{ background: weekendForm.direction === 'to_city' ? '#166534' : '#F9F9F6', color: weekendForm.direction === 'to_city' ? '#fff' : '#64748b' }}>{t('vp.toCityShort')}</button>
            </div>
            <select value={weekendForm.day_of_week} onChange={(e) => setWeekendForm({ ...weekendForm, day_of_week: +e.target.value })} className={inputCls}>
              {DAY_KEYS.map((k, i) => <option key={k} value={i}>{t(`vp.day.${k}`)}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={weekendForm.seats_total || ''} onChange={(e) => setWeekendForm({ ...weekendForm, seats_total: +e.target.value })} className={inputCls} /></div>
              <div><label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('cm.listedFareLabel')}</label><input type="number" value={weekendForm.fare_per_seat_pkr || ''} onChange={(e) => setWeekendForm({ ...weekendForm, fare_per_seat_pkr: +e.target.value })} className={inputCls} /></div>
            </div>
            <button onClick={addWeekendOffer} disabled={vpSaving} className="w-full bg-[#166534] text-white py-3 rounded-xl font-sans font-semibold cursor-pointer disabled:opacity-50">{vpSaving ? t('action.saving') : t('action.save')}</button>
          </div>
        </MobilityBottomSheet>
      )}
    </div>
  )
}
