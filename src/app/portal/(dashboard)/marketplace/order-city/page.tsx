'use client'

// Merged "Order from City" — replaces the separate city-shop-dispatch and
// city-fetch tiles with one screen. Opens on the home city (Chakwal) by
// default; an "Out of city" tab lists every other city. Either way, the
// vehicle list is always split into two sections mirroring the dispatch
// broadcast's own tier1/tier2 rule exactly (vehicles_available_for_city,
// 430): who's already in that city (cheap, flat purchasing fee once
// accepted) vs. village-based vehicles who'd have to travel there (the
// real round-trip fuel formula, roughly double). Posting broadcasts via
// the existing dispatch_calls machinery against that city's "General
// Purchase" placeholder shop — no need to pick a specific real shop first.
// A driver can also be messaged directly (reuses start_negotiation,
// kind='fetch') without going through the broadcast at all.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, Phone, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface City { id: string; name: string; name_ur: string | null; is_home_city: boolean }
interface VehicleRow { vehicle_id: string; owner_name: string; owner_mobile: string | null; vehicle_type: string; vehicle_number: string | null }
interface Available { present: VehicleRow[]; village: VehicleRow[] }
interface OutCitySummary { city: City; present: number; village: number }

export default function OrderCityPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [cities, setCities] = useState<City[]>([])
  const [generalShopByCity, setGeneralShopByCity] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<'home' | 'out'>('home')
  const [outCityId, setOutCityId] = useState<string | null>(null)
  const [outSummaries, setOutSummaries] = useState<OutCitySummary[] | null>(null)
  const [available, setAvailable] = useState<Available | null>(null)

  const [item, setItem] = useState('')
  const [budget, setBudget] = useState('')
  const [address, setAddress] = useState('')
  const [posting, setPosting] = useState(false)
  const [messagingId, setMessagingId] = useState<string | null>(null)

  const homeCity = cities.find((c) => c.is_home_city)
  const currentCity = tab === 'home' ? homeCity : cities.find((c) => c.id === outCityId)

  useEffect(() => {
    supabase.from('cities').select('id, name, name_ur, is_home_city').eq('is_active', true).order('display_order').then(({ data }) => setCities(data ?? []))
    supabase.from('city_shops').select('id, city_id').eq('is_general', true).then(({ data }) => {
      setGeneralShopByCity(Object.fromEntries((data ?? []).map((s) => [s.city_id, s.id])))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!currentCity) { setAvailable(null); return }
    setAvailable(null)
    supabase.rpc('vehicles_available_for_city', { p_city_id: currentCity.id }).then(({ data }) => setAvailable(data as Available))
  }, [currentCity]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'out' || outCityId || cities.length === 0) return
    const others = cities.filter((c) => !c.is_home_city)
    Promise.all(others.map((c) => supabase.rpc('vehicles_available_for_city', { p_city_id: c.id }).then(({ data }) => ({
      city: c, present: (data as Available)?.present?.length ?? 0, village: (data as Available)?.village?.length ?? 0,
    })))).then(setOutSummaries)
  }, [tab, outCityId, cities]) // eslint-disable-line react-hooks/exhaustive-deps

  const post = async () => {
    if (!currentCity) return
    const shopId = generalShopByCity[currentCity.id]
    if (!item.trim() || !address.trim() || !budget || !shopId) { toast.error(t('vp.fillDispatchFormError')); return }
    setPosting(true)
    const { data: callId, error } = await supabase.rpc('create_dispatch_call', {
      p_city_shop_id: shopId, p_item: item.trim(), p_address: address.trim(), p_goods_budget_pkr: Number(budget),
    })
    setPosting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/dispatch/${callId}`)
  }

  const messageDirect = async (vehicleId: string) => {
    if (!item.trim()) { toast.error(t('vp.describeItemFirst')); return }
    setMessagingId(vehicleId)
    const { data: threadId, error } = await supabase.rpc('start_negotiation', {
      p_kind: 'fetch', p_vehicle_id: vehicleId, p_item: item.trim(), p_qty: null,
      p_budget_pkr: budget ? Number(budget) : null, p_city_id: currentCity?.id,
    })
    setMessagingId(null)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    router.push(`/portal/marketplace/negotiations/${threadId}`)
  }

  if (userLoading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!user) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('p.couldNotLoad')}</div>

  const VehicleSection = ({ title, rows, tierNote }: { title: string; rows: VehicleRow[]; tierNote: string }) => (
    <div className="mb-4">
      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2 flex items-baseline gap-1.5">
        {title} <span className="font-normal normal-case tracking-normal text-[11px] opacity-70">— {tierNote}</span>
      </p>
      {rows.length === 0 && <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('vp.noVehiclesInSectionNote')}</p>}
      <div className="space-y-2">
        {rows.map((v) => (
          <div key={v.vehicle_id} className="flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3">
            <div className="min-w-0">
              <p className="font-sans text-[13.5px] font-semibold text-dp-on-surface truncate">{v.owner_name}</p>
              <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{v.vehicle_type}{v.vehicle_number ? ` · ${v.vehicle_number}` : ''}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {v.owner_mobile && <a href={`tel:${v.owner_mobile}`} className="flex items-center justify-center w-8 h-8 rounded-full bg-dp-secondary-container/50 text-dp-secondary hover:bg-dp-secondary hover:text-white transition-colors"><Phone size={13} /></a>}
              <button onClick={() => messageDirect(v.vehicle_id)} disabled={messagingId === v.vehicle_id} className="flex items-center justify-center w-8 h-8 rounded-full border border-dp-outline-variant text-dp-secondary hover:bg-dp-surface-container disabled:opacity-50" title={t('vp.messageDirectlyBtn')}>
                <MessageCircle size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto">
      <div className="mb-5">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><Truck size={22} className="text-dp-secondary" /> {t('vp.dispatchPageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vp.orderCitySubtitle')}</p>
      </div>

      <div className="flex items-center gap-0 mb-5 bg-dp-surface-container rounded-lg p-1">
        <button onClick={() => { setTab('home'); setOutCityId(null) }} className={`flex-1 text-center py-2 rounded-md font-sans text-[12.5px] font-bold cursor-pointer transition-all ${tab === 'home' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>
          {homeCity ? (isUrdu && homeCity.name_ur ? homeCity.name_ur : homeCity.name) : '…'} ({t('vp.homeCityLabel')})
        </button>
        <button onClick={() => setTab('out')} className={`flex-1 text-center py-2 rounded-md font-sans text-[12.5px] font-bold cursor-pointer transition-all ${tab === 'out' ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>
          {t('vp.outOfCityTabLabel')}
        </button>
      </div>

      {tab === 'out' && !outCityId && (
        <div className="space-y-2 mb-4">
          {outSummaries === null && <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>}
          {(outSummaries ?? []).map((s) => (
            <button key={s.city.id} onClick={() => setOutCityId(s.city.id)} className="w-full text-start flex items-center justify-between gap-3 bg-white border border-dp-outline-variant rounded-lg p-3.5 hover:border-dp-secondary transition-colors cursor-pointer">
              <p className="font-sans text-[14px] font-semibold text-dp-on-surface">{isUrdu && s.city.name_ur ? s.city.name_ur : s.city.name}</p>
              {s.present > 0
                ? <span className="font-sans text-[11px] font-bold text-dp-on-secondary-container flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-dp-secondary" /> {s.present} {t('vp.presentCountLabel')}</span>
                : s.village > 0
                  ? <span className="font-sans text-[11px] font-bold text-amber-700">{s.village} {t('vp.couldTravelCountLabel')}</span>
                  : <span className="font-sans text-[11px] text-dp-on-surface-variant opacity-60">{t('vp.noVehiclesAtAllNote')}</span>}
            </button>
          ))}
        </div>
      )}

      {(tab === 'home' || (tab === 'out' && outCityId)) && currentCity && (
        <>
          {tab === 'out' && (
            <button onClick={() => setOutCityId(null)} className="font-sans text-[12.5px] font-semibold text-dp-on-surface-variant hover:text-dp-secondary mb-3 cursor-pointer">← {t('vp.backToCityList')}</button>
          )}
          <div className="bg-white border-2 border-dp-primary rounded-lg p-3.5 mb-5 space-y-2.5">
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder={t('vp.itemPlaceholder')} className="input-field" />
            <div className="grid grid-cols-2 gap-2.5">
              <input type="number" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={t('vp.goodsBudgetPlaceholder')} className="input-field" />
              <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('vp.deliveryAddressPlaceholder')} className="input-field" />
            </div>
            <button onClick={post} disabled={posting} className="w-full bg-dp-primary text-white py-2.5 rounded-lg font-sans text-[13.5px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50">
              {posting ? t('action.saving') : t('vp.sendDispatchCallBtn')}
            </button>
          </div>

          {available === null && <p className="font-sans text-[13px] text-dp-on-surface-variant"><LoadingDots /></p>}
          {available && (
            <>
              <VehicleSection title={`${isUrdu && currentCity.name_ur ? currentCity.name_ur : currentCity.name} ${t('vp.presentSectionSuffix')}`} rows={available.present} tierNote={t('vp.presentTierNote')} />
              <VehicleSection title={t('vp.villageCarriersHeading')} rows={available.village} tierNote={t('vp.villageTierNote')} />
            </>
          )}
        </>
      )}
    </div>
  )
}
