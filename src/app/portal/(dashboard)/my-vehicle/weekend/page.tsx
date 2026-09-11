'use client'

// Weekend Offers — its own screen, matching the design zip (previously
// embedded on the driver dashboard).

import { useEffect, useState } from 'react'
import { CalendarClock, PlusCircle, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface WeekendOffer { id: string; city_name: string; city_name_ur: string | null; direction: string; day_of_week: number; seats_total: number; seats_taken: number; fare_per_seat_pkr: number; is_active: boolean }
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

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

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicleId) return null

  return (
    <div>
      <div className="flex items-center justify-between mb-2.5">
        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] flex items-center gap-1.5"><CalendarClock size={13} /> {t('vp.weekendOffersHeading')}</p>
        <button onClick={() => setShowAddWeekendOffer(true)} className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer"><PlusCircle size={12} /> {t('action.add')}</button>
      </div>
      {weekendOffers.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noWeekendOffersYet')}</p>}
      <div className="space-y-2">
        {weekendOffers.map((o) => (
          <div key={o.id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
            <div className="min-w-0">
              <p className="font-sans text-[13px] font-semibold text-dp-on-surface truncate">{isUrdu && o.city_name_ur ? o.city_name_ur : o.city_name} · {t(o.direction === 'to_village' ? 'vp.toVillageShort' : 'vp.toCityShort')}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t(`vp.day.${DAY_KEYS[o.day_of_week]}`)} · <span className="ltr-num">{o.seats_total - o.seats_taken}/{o.seats_total}</span> {t('vp.seatsFreeShortLabel')} · {fmt(o.fare_per_seat_pkr)}</p>
            </div>
            <button onClick={() => removeWeekendOffer(o.id)} className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg text-dp-error hover:bg-dp-error/10 cursor-pointer"><Trash2 size={13} /></button>
          </div>
        ))}
      </div>

      {showAddWeekendOffer && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAddWeekendOffer(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('vp.weekendOffersHeading')}</h2>
              <button onClick={() => setShowAddWeekendOffer(false)} className="cursor-pointer"><X size={20} /></button>
            </div>
            <div className="space-y-3">
              <select value={weekendForm.city_id} onChange={(e) => setWeekendForm({ ...weekendForm, city_id: e.target.value })} className="input-field">
                <option value="">{t('vp.pickCityOption')}</option>
                {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_village' })} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer ${weekendForm.direction === 'to_village' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.toVillageShort')}</button>
                <button type="button" onClick={() => setWeekendForm({ ...weekendForm, direction: 'to_city' })} className={`py-2 rounded-lg text-[13px] font-sans font-semibold cursor-pointer ${weekendForm.direction === 'to_city' ? 'bg-dp-secondary text-white' : 'bg-dp-surface-container text-dp-on-surface-variant'}`}>{t('vp.toCityShort')}</button>
              </div>
              <select value={weekendForm.day_of_week} onChange={(e) => setWeekendForm({ ...weekendForm, day_of_week: +e.target.value })} className="input-field">
                {DAY_KEYS.map((k, i) => <option key={k} value={i}>{t(`vp.day.${k}`)}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('mk.totalSeatsLabel')}</label><input type="number" value={weekendForm.seats_total || ''} onChange={(e) => setWeekendForm({ ...weekendForm, seats_total: +e.target.value })} className="input-field" /></div>
                <div><label className="block font-sans text-[12.5px] font-semibold text-dp-on-surface-variant mb-1">{t('cm.listedFareLabel')}</label><input type="number" value={weekendForm.fare_per_seat_pkr || ''} onChange={(e) => setWeekendForm({ ...weekendForm, fare_per_seat_pkr: +e.target.value })} className="input-field" /></div>
              </div>
              <button onClick={addWeekendOffer} disabled={vpSaving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">{vpSaving ? t('action.saving') : t('action.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
