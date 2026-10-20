'use client'

// Village stops along a posted route. "Auto-suggest" is honest about
// what it can actually do today: villages have no coordinates at all
// until a real stop gets confirmed against one (villages_near_path
// only ever matches villages that already have lat/lng) — so this
// always also offers a manual pin-drop, and confirming a manual stop
// against an existing village backfills that village's coordinates for
// every future route (create_route_stop, migration 717). Coverage
// grows with real use instead of needing a one-time data-entry project.

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { MapPin, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LocationPickerSheet, type PickedLocation } from '@/components/mobility/LocationPickerSheet'
import { MobilityBottomSheet } from '@/components/mobility/MobilityBottomSheet'
import { LoadingDots } from '@/components/shared/LoadingDots'

const LeafletMap = dynamic(() => import('@/components/shared/LeafletMap'), { ssr: false })

interface Stop { id: string; label: string; label_ur: string | null; lat: number; lng: number; stop_order: number }
interface NearbyVillage { village_id: string; name: string; name_ur: string | null; lat: number; lng: number; distance_km: number }

export function RouteStopsEditor({ routeId, routePath, onClose }: { routeId: string; routePath: { lat: number; lng: number }[] | null; onClose: () => void }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const [stops, setStops] = useState<Stop[]>([])
  const [nearby, setNearby] = useState<NearbyVillage[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [showPicker, setShowPicker] = useState(false)

  const load = async () => {
    const { data } = await supabase.from('route_stops').select('id, label, label_ur, lat, lng, stop_order').eq('route_id', routeId).order('stop_order')
    setStops(data ?? [])
    if (routePath && routePath.length > 0) {
      const { data: v } = await supabase.rpc('villages_near_path', { p_path: routePath, p_max_km: 2 })
      setNearby((v as NearbyVillage[] | null) ?? [])
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [routeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const addVillageStop = async (v: NearbyVillage) => {
    setAdding(true)
    const { error } = await supabase.rpc('create_route_stop', {
      p_route_id: routeId, p_label: v.name, p_label_ur: v.name_ur, p_lat: v.lat, p_lng: v.lng, p_village_id: v.village_id, p_stop_order: stops.length + 1,
    })
    setAdding(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.stopAddedToast'))
    setNearby((rows) => rows.filter((r) => r.village_id !== v.village_id))
    load()
  }

  const addManualStop = async (loc: PickedLocation) => {
    setShowPicker(false)
    setAdding(true)
    const { error } = await supabase.rpc('create_route_stop', {
      p_route_id: routeId, p_label: loc.label, p_label_ur: null, p_lat: loc.lat, p_lng: loc.lng, p_village_id: null, p_stop_order: stops.length + 1,
    })
    setAdding(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('mv.stopAddedToast'))
    load()
  }

  const addedVillageIds = new Set(stops.map((s) => s.label))
  const suggestions = nearby.filter((v) => !addedVillageIds.has(v.name))

  return (
    <MobilityBottomSheet title={t('mv.manageStopsHeading')} onClose={onClose}>
      {loading ? (
        <div className="text-center py-8"><LoadingDots /></div>
      ) : showPicker ? (
        <LocationPickerSheet title={t('mv.addStopManuallyBtn')} inline onClose={() => setShowPicker(false)} onConfirm={addManualStop} />
      ) : (
        <div className="flex flex-col gap-2.5">
          <p className="font-sans text-[11.5px] text-[#64748b]">{t('mv.manageStopsHint')}</p>

          {(stops.length > 0 || (routePath && routePath.length > 0)) && (
            <LeafletMap
              pins={stops.map((s) => ({ lat: s.lat, lng: s.lng, label: isUrdu && s.label_ur ? s.label_ur : s.label, color: '#166534', emoji: '📍' }))}
              route={routePath ?? undefined}
              height={150} className="rounded-xl"
            />
          )}

          {stops.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {stops.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 rounded-lg bg-[#f0fdf4] px-2.5 py-1.5">
                  <span className="shrink-0 w-5 h-5 rounded-full bg-[#166534] text-white text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                  <span className="flex-1 min-w-0 font-sans text-[12px] font-semibold text-[#166534] truncate">{isUrdu && s.label_ur ? s.label_ur : s.label}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#64748b] mb-1.5">{t('mv.suggestedStopsLabel')}</p>
            {suggestions.length === 0 ? (
              <p className="font-sans text-[11.5px] text-[#94a3b8]">{t('mv.noSuggestedStops')}</p>
            ) : (
              <div className="flex gap-1.5 flex-wrap">
                {suggestions.map((v) => (
                  <button key={v.village_id} onClick={() => addVillageStop(v)} disabled={adding}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-full border border-[#e5e2d0] font-sans text-[11.5px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50">
                    <Plus size={11} /> {isUrdu && v.name_ur ? v.name_ur : v.name} <span className="text-[#94a3b8] ltr-num">({v.distance_km}km)</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={() => setShowPicker(true)} className="flex items-center justify-center gap-1.5 w-full border border-[#e5e2d0] rounded-xl py-2.5 font-sans text-[12.5px] font-semibold text-[#166534] cursor-pointer">
            <MapPin size={14} /> {t('mv.addStopManuallyBtn')}
          </button>
        </div>
      )}
    </MobilityBottomSheet>
  )
}
