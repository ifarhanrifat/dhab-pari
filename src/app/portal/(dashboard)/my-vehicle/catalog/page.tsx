'use client'

// A vehicle owner's own side of the hourly rental / shadi catalog (474):
// photos, colour, model, AC, and the two opt-in switches — everything
// EXCEPT the actual rate, which stays committee-set (a deliberate
// departure from per_km_pkr's own self-service precedent, confirmed
// directly — bigger, less frequent bookings warranting more oversight).
// Turning either switch on is refused server-side until the committee
// has actually set a rate, so a vehicle can never list itself bookable
// at a null price.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Camera, Star, Trash2, Loader2, Clock3, Users2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Vehicle {
  id: string; owner_name: string; color: string | null; model: string | null; has_ac: boolean
  offers_hourly: boolean; offers_shadi: boolean
  hourly_rate_pkr: number | null; hourly_included_km: number | null; hourly_overage_per_km_pkr: number | null
  shadi_full_day_rate_pkr: number | null
}
interface Photo { id: string; url: string; is_cover: boolean }

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

export default function MyVehicleCatalogPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const supabase = createClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  const [color, setColor] = useState('')
  const [model, setModel] = useState('')
  const [hasAc, setHasAc] = useState(false)
  const [offersHourly, setOffersHourly] = useState(false)
  const [offersShadi, setOffersShadi] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadPhotos = (vehicleId: string) =>
    supabase.from('vehicle_media').select('id, url, is_cover').eq('vehicle_id', vehicleId).order('is_cover', { ascending: false })
      .then(({ data }) => setPhotos((data ?? []) as Photo[]))

  useEffect(() => {
    if (!user) return
    supabase.from('vehicles').select('id, owner_name, color, model, has_ac, offers_hourly, offers_shadi, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr, shadi_full_day_rate_pkr')
      .eq('portal_user_id', user.id).maybeSingle().then(async ({ data }) => {
        setVehicle(data)
        if (data) {
          setColor(data.color ?? ''); setModel(data.model ?? ''); setHasAc(data.has_ac)
          setOffersHourly(data.offers_hourly); setOffersShadi(data.offers_shadi)
          await loadPhotos(data.id)
        }
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const save = async () => {
    if (!vehicle) return
    setSaving(true)
    const { error } = await supabase.rpc('set_vehicle_catalog_prefs', {
      p_vehicle_id: vehicle.id, p_color: color, p_model: model, p_has_ac: hasAc, p_offers_hourly: offersHourly, p_offers_shadi: offersShadi,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('g.saveChanges'))
    setVehicle((v) => v ? { ...v, color: color.trim() || null, model: model.trim() || null, has_ac: hasAc, offers_hourly: offersHourly, offers_shadi: offersShadi } : v)
  }

  const uploadPhoto = async (file: File) => {
    if (!vehicle) return
    setUploading(true)
    try {
      const path = `vehicle_${vehicle.id}_${Date.now()}_${file.name.replace(/\s+/g, '_')}`
      const { data: uploaded, error: uploadErr } = await supabase.storage.from('images').upload(path, file)
      if (uploadErr) throw uploadErr
      const publicUrl = supabase.storage.from('images').getPublicUrl(uploaded.path).data.publicUrl
      const { error } = await supabase.from('vehicle_media').insert({ vehicle_id: vehicle.id, url: publicUrl, is_cover: photos.length === 0 })
      if (error) throw error
      await loadPhotos(vehicle.id)
      toast.success(t('mv.photoAddedToast'))
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setUploading(false)
    }
  }

  const makeCover = async (photo: Photo) => {
    if (!vehicle) return
    // One cover per vehicle (vehicle_media_one_cover_per_vehicle) — clear
    // the old one first so the new one doesn't collide with it.
    await supabase.from('vehicle_media').update({ is_cover: false }).eq('vehicle_id', vehicle.id).eq('is_cover', true)
    const { error } = await supabase.from('vehicle_media').update({ is_cover: true }).eq('id', photo.id)
    if (error) { toast.error(friendlyError(error)); return }
    loadPhotos(vehicle.id)
  }

  const removePhoto = async (photo: Photo) => {
    if (!confirm(t('mv.confirmRemovePhoto'))) return
    const { error } = await supabase.from('vehicle_media').delete().eq('id', photo.id)
    if (error) { toast.error(friendlyError(error)); return }
    if (vehicle) loadPhotos(vehicle.id)
  }

  if (userLoading || loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('cm.noVehicleLinked')}</div>

  const hasHourlyRate = vehicle.hourly_rate_pkr != null
  const hasShadiRate = vehicle.shadi_full_day_rate_pkr != null

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <Link href="/portal/my-vehicle" className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-3">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {vehicle.owner_name}
      </Link>
      <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2 mb-1"><Camera size={22} /> {t('mv.catalogHeading')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-4">{t('mv.catalogSubtitle')}</p>

      {/* Photos */}
      <div className="mb-5">
        <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-dp-on-surface-variant mb-2">{t('mv.photosLabel')}</p>
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <div key={p.id} className="relative border border-dp-outline-variant rounded-lg overflow-hidden aspect-square">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" className="w-full h-full object-cover" />
              {p.is_cover && (
                <span className="absolute top-1 start-1 bg-dp-secondary text-white rounded px-1.5 py-0.5 text-[9px] font-sans font-bold flex items-center gap-0.5"><Star size={9} fill="currentColor" /> {t('mv.coverLabel')}</span>
              )}
              <div className="absolute bottom-1 inset-x-1 flex items-center gap-1">
                {!p.is_cover && (
                  <button onClick={() => makeCover(p)} className="flex-1 bg-white/90 rounded text-[9px] font-sans font-semibold py-1 cursor-pointer">{t('mv.makeCoverBtn')}</button>
                )}
                <button onClick={() => removePhoto(p)} className="bg-white/90 rounded p-1 cursor-pointer text-dp-error"><Trash2 size={11} /></button>
              </div>
            </div>
          ))}
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="aspect-square border-2 border-dashed border-dp-outline-variant rounded-lg flex flex-col items-center justify-center gap-1 text-dp-on-surface-variant cursor-pointer hover:border-dp-secondary disabled:opacity-50">
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
            <span className="font-sans text-[10px]">{t('mv.addPhotoBtn')}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = '' }} />
        </div>
      </div>

      {/* Color / model / AC */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('mv.colorLabel')}</label>
            <input value={color} onChange={(e) => setColor(e.target.value)} placeholder={t('mv.colorPlaceholder')} className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px]" />
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1">{t('mv.modelLabel')}</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('mv.modelPlaceholder')} className="w-full border border-dp-outline-variant rounded-lg p-2.5 font-sans text-[13.5px]" />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer mt-3">
          <input type="checkbox" checked={hasAc} onChange={(e) => setHasAc(e.target.checked)} className="accent-dp-secondary" />
          <span className="font-sans text-[13.5px] text-dp-on-surface">{t('mv.hasAcLabel')}</span>
        </label>
      </div>

      {/* Hourly opt-in — rate is read-only here, committee-set */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
        {hasHourlyRate ? (
          <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-dp-outline-variant">
            <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('mv.yourRateLabel')}</span>
            <span className="font-heading text-[16px] font-bold text-dp-secondary ltr-num">
              {fmt(vehicle.hourly_rate_pkr!)}/{t('mv.perHourShort')}
              {vehicle.hourly_included_km != null && <span className="font-sans text-[11px] text-dp-on-surface-variant font-normal"> · {fmt(vehicle.hourly_included_km)}km {t('mv.includedShort')}</span>}
            </span>
          </div>
        ) : (
          <p className="font-sans text-[12.5px] mb-3 pb-3 border-b border-dp-outline-variant" style={{ color: '#ae1800' }}>{t('mv.noRateSetHint')}</p>
        )}
        <label className={`flex items-center gap-2 ${hasHourlyRate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
          <input type="checkbox" checked={offersHourly} disabled={!hasHourlyRate} onChange={(e) => setOffersHourly(e.target.checked)} className="accent-dp-secondary" />
          <Clock3 size={15} className="text-dp-on-surface-variant" />
          <span className="font-sans text-[13.5px] text-dp-on-surface">{t('mv.offersHourlyLabel')}</span>
        </label>
      </div>

      {/* Shadi (wedding) opt-in — its own rate, its own gate */}
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-4">
        {hasShadiRate ? (
          <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-dp-outline-variant">
            <span className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('mv.yourShadiRateLabel')}</span>
            <span className="font-heading text-[16px] font-bold text-dp-secondary ltr-num">{fmt(vehicle.shadi_full_day_rate_pkr!)}/{t('mv.perDayShort')}</span>
          </div>
        ) : (
          <p className="font-sans text-[12.5px] mb-3 pb-3 border-b border-dp-outline-variant" style={{ color: '#ae1800' }}>{t('mv.noShadiRateSetHint')}</p>
        )}
        <label className={`flex items-center gap-2 ${hasShadiRate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
          <input type="checkbox" checked={offersShadi} disabled={!hasShadiRate} onChange={(e) => setOffersShadi(e.target.checked)} className="accent-dp-secondary" />
          <Users2 size={15} className="text-dp-on-surface-variant" />
          <span className="font-sans text-[13.5px] text-dp-on-surface">{t('mv.offersShadiLabel')}</span>
        </label>
      </div>

      <button onClick={save} disabled={saving} className="w-full bg-dp-secondary text-white rounded-lg py-3 font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
        {saving ? t('action.saving') : t('g.saveChanges')}
      </button>
    </div>
  )
}
