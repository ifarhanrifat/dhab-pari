'use client'

// Weekend commuter matching — set your work-city + weekly rhythm once
// (set_commuter_schedule), see the share rides that actually match it
// (my_commuter_matches implements the spec's match() rule), request a
// seat on one (request_share_seat — reuses negotiation_threads exactly
// like city-fetch does, kind='share').

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarClock, Home, Building2, Phone, Send, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface City { id: string; name: string; name_ur: string | null }
interface MatchOffer { offer_id: string; vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; vehicle_number: string | null; depart_time: string | null; seats_free: number; fare_per_seat_pkr: number; day_of_week: number }
interface Matches { schedule: { id: string; work_city_id: string; city_name: string; city_name_ur: string | null; home_day: number; back_day: number } | null; to_village: MatchOffer[]; to_city: MatchOffer[] }

function fmt(n: number) { return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }) }
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export default function CommutePage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [matches, setMatches] = useState<Matches | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [formCity, setFormCity] = useState('')
  const [formHomeDay, setFormHomeDay] = useState(6)
  const [formBackDay, setFormBackDay] = useState(1)
  const [saving, setSaving] = useState(false)
  const [requestingOfferId, setRequestingOfferId] = useState<string | null>(null)

  const dayLabel = (d: number) => t(`vp.day.${DAY_KEYS[d]}`)

  const reload = async () => {
    const { data } = await supabase.rpc('my_commuter_matches')
    setMatches(data as Matches)
    setLoading(false)
    if (data?.schedule) { setFormCity(data.schedule.work_city_id); setFormHomeDay(data.schedule.home_day); setFormBackDay(data.schedule.back_day) }
    else setEditing(true)
  }

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (user) reload() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveSchedule = async () => {
    if (!formCity) { toast.error(t('vp.pickCityOption')); return }
    setSaving(true)
    const { error } = await supabase.rpc('set_commuter_schedule', { p_work_city_id: formCity, p_home_day: formHomeDay, p_back_day: formBackDay })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vp.scheduleSavedToast'))
    setEditing(false)
    reload()
  }

  const requestSeat = async (offerId: string) => {
    setRequestingOfferId(offerId)
    const { data: threadId, error } = await supabase.rpc('request_share_seat', { p_offer_id: offerId })
    setRequestingOfferId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/negotiations/${threadId}`)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const OfferCard = ({ o }: { o: MatchOffer }) => (
    <div className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
      <div className="min-w-0">
        <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{o.owner_name}</p>
        <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{o.vehicle_type}{o.depart_time ? ` · ${o.depart_time.slice(0, 5)}` : ''} · <span className="ltr-num">{o.seats_free}</span> {t('vp.seatsFreeShortLabel')}</p>
        <p className="font-sans text-[13px] font-bold text-dp-secondary mt-0.5 ltr-num">{fmt(o.fare_per_seat_pkr)} <span className="font-normal text-dp-on-surface-variant text-[11px]">{t('mk.perSeat')}</span></p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {o.owner_mobile && <a href={`tel:${o.owner_mobile}`} className="flex items-center justify-center w-8 h-8 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors"><Phone size={13} /></a>}
        <button onClick={() => requestSeat(o.offer_id)} disabled={requestingOfferId === o.offer_id} className="flex items-center gap-1 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">
          <Send size={12} /> {requestingOfferId === o.offer_id ? t('action.saving') : t('vp.requestSeatBtn')}
        </button>
      </div>
    </div>
  )

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><CalendarClock size={22} className="text-dp-secondary" /> {t('vp.commutePageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.commutePageSubtitle')}</p>
      </div>

      {!editing && matches?.schedule ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-6 flex items-center justify-between gap-3">
          <div>
            <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface">{isUrdu && matches.schedule.city_name_ur ? matches.schedule.city_name_ur : matches.schedule.city_name}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('vp.homeOnLabel')} {dayLabel(matches.schedule.home_day)} · {t('vp.backOnLabel')} {dayLabel(matches.schedule.back_day)}</p>
          </div>
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 font-sans text-[12px] font-semibold text-dp-secondary hover:underline cursor-pointer"><Pencil size={11} /> {t('action.edit')}</button>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-6 space-y-2.5">
          <select value={formCity} onChange={(e) => setFormCity(e.target.value)} className="input-field">
            <option value="">{t('vp.pickWorkCityOption')}</option>
            {cities.map((c) => <option key={c.id} value={c.id}>{isUrdu && c.name_ur ? c.name_ur : c.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.homeDayLabel')}</label>
              <select value={formHomeDay} onChange={(e) => setFormHomeDay(+e.target.value)} className="input-field">
                {DAY_KEYS.map((k, i) => <option key={k} value={i}>{t(`vp.day.${k}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('vp.backDayLabel')}</label>
              <select value={formBackDay} onChange={(e) => setFormBackDay(+e.target.value)} className="input-field">
                {DAY_KEYS.map((k, i) => <option key={k} value={i}>{t(`vp.day.${k}`)}</option>)}
              </select>
            </div>
          </div>
          <button onClick={saveSchedule} disabled={saving} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50">{saving ? t('action.saving') : t('vp.saveScheduleBtn')}</button>
        </div>
      )}

      {matches?.schedule && (
        <>
          <div className="mb-6">
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Home size={13} /> {t('vp.toVillageHeading')} · {dayLabel(matches.schedule.home_day)}</p>
            {matches.to_village.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noMatchesYet')}</p>}
            <div className="space-y-2">{matches.to_village.map((o) => <OfferCard key={o.offer_id} o={o} />)}</div>
          </div>
          <div>
            <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5 flex items-center gap-1.5"><Building2 size={13} /> {t('vp.toCityHeading')} · {dayLabel(matches.schedule.back_day)}</p>
            {matches.to_city.length === 0 && <p className="font-sans text-[13px] text-dp-on-surface-variant">{t('vp.noMatchesYet')}</p>}
            <div className="space-y-2">{matches.to_city.map((o) => <OfferCard key={o.offer_id} o={o} />)}</div>
          </div>
        </>
      )}
    </div>
  )
}
