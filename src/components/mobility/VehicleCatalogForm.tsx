'use client'

// Extracted from my-vehicle/catalog/page.tsx so it can render identically
// in two places: that page itself (a solo driver's own catalog, full
// page — unchanged) and inline inside a bottom sheet from Fleet's "Bus
// Management" page (875 UI pass) — real complaint fixed: clicking
// "Settings" on a fleet vehicle used to navigate clean out of the Fleet
// shell into my-vehicle's own layout (a different bottom nav entirely),
// a jarring context switch for something that's really just a form.

import { useEffect, useRef, useState } from 'react'
import { Camera, Star, Trash2, Loader2, Clock3, Users2, Navigation, Lock, BedSingle, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface Vehicle {
  id: string; owner_name: string; vehicle_type: string; color: string | null; model: string | null; has_ac: boolean; model_year: number | null
  offers_hourly: boolean; offers_shadi: boolean; offers_rental: boolean; is_sleeper: boolean
  hourly_rate_pkr: number | null; hourly_included_km: number | null; hourly_overage_per_km_pkr: number | null
  shadi_full_day_rate_pkr: number | null; shadi_vehicle_class: string | null
  rental_tier: string | null
  total_seats: number | null; vehicle_categories: { vehicle_kind: string } | null
}
interface Photo { id: string; url: string; is_cover: boolean }
interface ShadiClass { class_key: string; name_en: string; name_ur: string }
interface FareGuide {
  tier_key: string; hourly_rate_pkr: number; hourly_included_km_per_hour: number; hourly_overage_per_km_pkr: number
  rental_base_pkr: number; rental_per_km_pkr: number; rental_wait_hour_pkr: number
}

function shadiClassMatchesVehicleType(classKey: string, vehicleType: string): boolean {
  const t = vehicleType.toLowerCase()
  if (classKey === 'hiace') return t.includes('hiace')
  if (classKey === 'bolan') return t.includes('bolan')
  if (classKey === 'sedan') return !t.includes('hiace') && !t.includes('bolan')
  return true
}

function fmt(n: number) {
  return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })
}

interface DocStatus { document_type: string; expiry_date: string; file_url: string | null; days_remaining: number; status: 'valid' | 'expiring_soon' | 'expired' }
const DOC_TYPES = ['route_permit', 'fitness_certificate', 'insurance', 'driver_licence'] as const

export function VehicleCatalogForm({ vehicleId, showHeading = true }: { vehicleId: string; showHeading?: boolean }) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()
  const fileRef = useRef<HTMLInputElement>(null)

  const [vehicle, setVehicle] = useState<Vehicle | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  const [color, setColor] = useState('')
  const [model, setModel] = useState('')
  const [modelYear, setModelYear] = useState<number | null>(null)
  const [hasAc, setHasAc] = useState(false)
  const [offersHourly, setOffersHourly] = useState(false)
  const [offersShadi, setOffersShadi] = useState(false)
  const [offersRental, setOffersRental] = useState(false)
  const [isSleeper, setIsSleeper] = useState(false)
  const [shadiVehicleClass, setShadiVehicleClass] = useState<string>('')
  const [shadiClasses, setShadiClasses] = useState<ShadiClass[]>([])
  const [rentalTier, setRentalTier] = useState<string>('')
  const [fareGuides, setFareGuides] = useState<FareGuide[]>([])
  const [saving, setSaving] = useState(false)
  const [docs, setDocs] = useState<DocStatus[]>([])
  const [docDraftDate, setDocDraftDate] = useState<Record<string, string>>({})
  const [savingDoc, setSavingDoc] = useState<string | null>(null)

  const loadPhotos = (vid: string) =>
    supabase.from('vehicle_media').select('id, url, is_cover').eq('vehicle_id', vid).order('is_cover', { ascending: false })
      .then(({ data }) => setPhotos((data ?? []) as Photo[]))

  useEffect(() => {
    if (!vehicleId) return
    setLoading(true)
    supabase.from('vehicles').select('id, owner_name, vehicle_type, color, model, model_year, has_ac, offers_hourly, offers_shadi, offers_rental, is_sleeper, hourly_rate_pkr, hourly_included_km, hourly_overage_per_km_pkr, shadi_full_day_rate_pkr, shadi_vehicle_class, rental_tier, total_seats, vehicle_categories(vehicle_kind)')
      .eq('id', vehicleId).maybeSingle().then(async ({ data }) => {
        setVehicle(data as unknown as Vehicle)
        if (data) {
          setColor(data.color ?? ''); setModel(data.model ?? ''); setModelYear(data.model_year ?? null); setHasAc(data.has_ac)
          setOffersHourly(data.offers_hourly); setOffersShadi(data.offers_shadi); setOffersRental(data.offers_rental)
          setIsSleeper(data.is_sleeper ?? false)
          setShadiVehicleClass(data.shadi_vehicle_class ?? '')
          setRentalTier(data.rental_tier ?? '')
          await loadPhotos(data.id)
        }
        setLoading(false)
      })
    supabase.rpc('shadi_vehicle_classes_list').then(({ data }) => setShadiClasses((data ?? []) as ShadiClass[]))
    supabase.rpc('rental_tier_fare_guides_list').then(({ data }) => setFareGuides((data ?? []) as FareGuide[]))
    loadDocs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId])

  const loadDocs = () => {
    supabase.rpc('vehicle_document_status', { p_vehicle_id: vehicleId }).then(({ data }) => setDocs((data ?? []) as DocStatus[]))
  }

  const saveDoc = async (docType: string) => {
    const date = docDraftDate[docType]
    if (!date) { toast.error(t('mv.enterExpiryDateError')); return }
    setSavingDoc(docType)
    const { error } = await supabase.rpc('set_vehicle_document', { p_vehicle_id: vehicleId, p_document_type: docType, p_expiry_date: date })
    setSavingDoc(null)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('g.saveChanges'))
    setDocDraftDate((d) => ({ ...d, [docType]: '' }))
    loadDocs()
  }

  const saveDocFile = async (docType: string, path: string) => {
    if (!path) return
    const existing = docs.find((d) => d.document_type === docType)
    const expiryDate = existing?.expiry_date ?? docDraftDate[docType]
    if (!expiryDate) { toast.error(t('mv.enterExpiryDateFirstError')); return }
    const { error } = await supabase.rpc('set_vehicle_document', {
      p_vehicle_id: vehicleId, p_document_type: docType, p_expiry_date: expiryDate, p_file_url: path,
    })
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('mv.documentUploadedToast'))
    loadDocs()
  }

  const save = async () => {
    if (!vehicle) return
    setSaving(true)
    const { error } = await supabase.rpc('set_vehicle_catalog_prefs', {
      p_vehicle_id: vehicle.id, p_color: color, p_model: model, p_has_ac: hasAc, p_offers_hourly: offersHourly, p_offers_shadi: offersShadi, p_offers_rental: offersRental,
      p_shadi_vehicle_class: shadiVehicleClass || null, p_rental_tier: rentalTier || null, p_model_year: modelYear, p_is_sleeper: isSleeper,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('g.saveChanges'))
    setVehicle((v) => v ? { ...v, color: color.trim() || null, model: model.trim() || null, model_year: modelYear, has_ac: hasAc, offers_hourly: offersHourly, offers_shadi: offersShadi, offers_rental: offersRental, is_sleeper: isSleeper, shadi_vehicle_class: shadiVehicleClass || v.shadi_vehicle_class, rental_tier: rentalTier || v.rental_tier } : v)
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

  if (loading) return <div className="text-center py-12"><LoadingDots /></div>
  if (!vehicle) return <div className="text-center py-12 text-[#64748b] text-[14px]">{t('cm.noVehicleLinked')}</div>

  const fareGuide = rentalTier ? fareGuides.find((g) => g.tier_key === rentalTier) ?? null : null
  const hasHourlyRate = fareGuide != null
  const hasShadiRate = vehicle.shadi_full_day_rate_pkr != null
  const hasRentalRate = fareGuide != null

  return (
    <div className="flex flex-col gap-3">
      {showHeading && (
        <div>
          <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary flex items-center gap-2"><Camera size={19} /> {t('mv.catalogHeading')}</h1>
          <p className="text-[12.5px] text-[#64748b] mt-0.5">{vehicle.owner_name}</p>
        </div>
      )}

      <div>
        <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2">{t('mv.photosLabel')}</p>
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p) => (
            <div key={p.id} className="relative border border-[#e5e2d0] rounded-xl overflow-hidden aspect-square">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" className="w-full h-full object-cover" />
              {p.is_cover && (
                <span className="absolute top-1 start-1 bg-[#166534] text-white rounded px-1.5 py-0.5 text-[9px] font-sans font-bold flex items-center gap-0.5"><Star size={9} fill="currentColor" /> {t('mv.coverLabel')}</span>
              )}
              <div className="absolute bottom-1 inset-x-1 flex items-center gap-1">
                {!p.is_cover && (
                  <button onClick={() => makeCover(p)} className="flex-1 bg-white/90 rounded text-[9px] font-sans font-semibold py-1 cursor-pointer">{t('mv.makeCoverBtn')}</button>
                )}
                <button onClick={() => removePhoto(p)} className="bg-white/90 rounded p-1 cursor-pointer text-[#b91c1c]"><Trash2 size={11} /></button>
              </div>
            </div>
          ))}
          <button onClick={() => fileRef.current?.click()} disabled={uploading}
            className="aspect-square border-2 border-dashed border-[#e5e2d0] rounded-xl flex flex-col items-center justify-center gap-1 text-[#64748b] cursor-pointer disabled:opacity-50">
            {uploading ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
            <span className="font-sans text-[10px]">{t('mv.addPhotoBtn')}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = '' }} />
        </div>
      </div>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mv.colorLabel')}</label>
            <p className="font-sans text-[13.5px] font-semibold text-[#1e293b]">{color || '—'}</p>
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mv.modelLabel')}</label>
            <p className="font-sans text-[13.5px] font-semibold text-[#1e293b]">{model || '—'}</p>
          </div>
          <div>
            <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('mv.modelYearLabel')}</label>
            <p className="font-sans text-[13.5px] font-semibold text-[#1e293b] ltr-num">{modelYear ?? '—'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <input type="checkbox" checked={hasAc} disabled readOnly className="accent-[#166534] opacity-60" />
          <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.hasAcLabel')}</span>
        </div>
        <div className="flex items-start gap-2 bg-[#F9F9F6] rounded-xl p-3 mt-3">
          <Lock size={14} className="text-[#64748b] shrink-0 mt-0.5" />
          <p className="font-sans text-[12px] text-[#64748b] leading-[1.6]">{t('mv.vehicleFactsLockNote')}</p>
        </div>
      </div>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        {fareGuide ? (
          <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-[#f1f5f9]">
            <span className="font-sans text-[12.5px] text-[#64748b]">{t('mv.yourRateLabel')}</span>
            <span className="font-bold text-[16px] text-[#166534] ltr-num">
              {fmt(fareGuide.hourly_rate_pkr)}/{t('mv.perHourShort')}
              <span className="font-sans text-[11px] text-[#64748b] font-normal"> · {fmt(fareGuide.hourly_included_km_per_hour)}km/{t('mv.perHourShort')} {t('mv.includedShort')}</span>
            </span>
          </div>
        ) : (
          <p className="font-sans text-[12.5px] mb-3 pb-3 border-b border-[#f1f5f9] text-[#b91c1c]">{t('mv.noRentalTierHint')}</p>
        )}
        <label className={`flex items-center gap-2 ${hasHourlyRate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
          <input type="checkbox" checked={offersHourly} disabled={!hasHourlyRate} onChange={(e) => setOffersHourly(e.target.checked)} className="accent-[#166534]" />
          <Clock3 size={15} className="text-[#64748b]" />
          <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.offersHourlyLabel')}</span>
        </label>
      </div>

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        {fareGuide ? (
          <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-[#f1f5f9]">
            <span className="font-sans text-[12.5px] text-[#64748b]">{t('mv.yourRentalRateLabel')}</span>
            <span className="font-bold text-[16px] text-[#166534] ltr-num">
              {fmt(fareGuide.rental_base_pkr)} + {fmt(fareGuide.rental_per_km_pkr)}/km
            </span>
          </div>
        ) : (
          <p className="font-sans text-[12.5px] mb-3 pb-3 border-b border-[#f1f5f9] text-[#b91c1c]">{t('mv.noRentalTierHint')}</p>
        )}
        <label className={`flex items-center gap-2 ${hasRentalRate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
          <input type="checkbox" checked={offersRental} disabled={!hasRentalRate} onChange={(e) => setOffersRental(e.target.checked)} className="accent-[#166534]" />
          <Navigation size={15} className="text-[#64748b]" />
          <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.offersRentalLabel')}</span>
        </label>
        <div className="mt-3 pt-3 border-t border-[#f1f5f9]">
          <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.yourRentalTierLabel')}</label>
          <p className="font-sans text-[13.5px] font-semibold text-[#1e293b]">{rentalTier ? t(`vp.rentalTier.${rentalTier}`) : '—'}</p>
          <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('vp.rentalTierCommitteeSetNote')} {t('mv.rateFromCategoryNote')}</p>
        </div>
      </div>

      {vehicle?.vehicle_categories?.vehicle_kind === 'van' && (vehicle.total_seats ?? 0) >= 10 && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isSleeper} onChange={(e) => setIsSleeper(e.target.checked)} className="accent-[#166534]" />
            <BedSingle size={15} className="text-[#64748b]" />
            <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.isSleeperLabel')}</span>
          </label>
          <p className="font-sans text-[11px] text-[#64748b] mt-1.5">{t('mv.isSleeperHint')}</p>
        </div>
      )}

      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        {hasShadiRate ? (
          <div className="flex items-center justify-between gap-3 mb-3 pb-3 border-b border-[#f1f5f9]">
            <span className="font-sans text-[12.5px] text-[#64748b]">{t('mv.yourShadiRateLabel')}</span>
            <span className="font-bold text-[16px] text-[#166534] ltr-num">{fmt(vehicle.shadi_full_day_rate_pkr!)}/{t('mv.perDayShort')}</span>
          </div>
        ) : (
          <p className="font-sans text-[12.5px] mb-3 pb-3 border-b border-[#f1f5f9] text-[#b91c1c]">{t('mv.noShadiRateSetHint')}</p>
        )}
        <label className={`flex items-center gap-2 ${hasShadiRate ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
          <input type="checkbox" checked={offersShadi} disabled={!hasShadiRate} onChange={(e) => setOffersShadi(e.target.checked)} className="accent-[#166534]" />
          <Users2 size={15} className="text-[#64748b]" />
          <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.offersShadiLabel')}</span>
        </label>

        <div className="mt-3 pt-3 border-t border-[#f1f5f9]">
          <label className="block font-sans text-[12px] font-semibold text-[#64748b] mb-1">{t('vp.yourFleetClassLabel')}</label>
          <select value={shadiVehicleClass} onChange={(e) => setShadiVehicleClass(e.target.value)} className="dp2-input font-sans text-[13.5px]">
            <option value="">—</option>
            {shadiClasses.filter((c) => shadiClassMatchesVehicleType(c.class_key, vehicle?.vehicle_type ?? '')).map((c) => <option key={c.class_key} value={c.class_key}>{isUrdu ? c.name_ur : c.name_en}</option>)}
          </select>
          <p className="font-sans text-[11px] text-[#64748b] mt-1">{t('vp.fleetClassLockedToVehicleNote').replace('{vehicleType}', vehicle?.vehicle_type ?? '')}</p>
        </div>
      </div>

      {/* 881: real gap — vehicle_registration_requests only ever
          captured documents once, at approval, with no expiry date
          tracked anywhere. These three track renewal dates so a lapsed
          route permit/fitness certificate/insurance doesn't go
          unnoticed; alerting only, doesn't block dispatch. */}
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4">
        <p className="font-sans text-[11px] font-bold uppercase tracking-[0.06em] text-[#64748b] mb-2.5 flex items-center gap-1.5"><ShieldAlert size={13} /> {t('mv.complianceDocsHeading')}</p>
        <div className="flex flex-col gap-3">
          {DOC_TYPES.map((docType) => {
            const existing = docs.find((d) => d.document_type === docType)
            return (
              <div key={docType} className="border border-[#e5e2d0] rounded-xl p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="font-sans text-[13px] font-semibold text-[#1e293b]">{t(`mv.docType.${docType}`)}</span>
                  {existing && (
                    <span className="shrink-0 px-2 py-0.5 rounded-full font-sans text-[9.5px] font-bold"
                      style={{
                        background: existing.status === 'expired' ? '#FEF2F2' : existing.status === 'expiring_soon' ? '#FFFBEB' : '#F0FDF4',
                        color: existing.status === 'expired' ? '#b91c1c' : existing.status === 'expiring_soon' ? '#b45309' : '#166534',
                      }}>
                      {existing.status === 'expired' ? t('mv.docStatusExpired') : existing.status === 'expiring_soon' ? t('mv.docStatusExpiringSoon') : t('mv.docStatusValid')}
                    </span>
                  )}
                </div>
                {existing && <p className="font-sans text-[11px] text-[#64748b] mb-2 ltr-num">{t('mv.expiresOnLabel')}: {existing.expiry_date}</p>}
                <div className="flex gap-2 mb-2">
                  <input type="date" value={docDraftDate[docType] ?? ''} onChange={(e) => setDocDraftDate((d) => ({ ...d, [docType]: e.target.value }))}
                    className="flex-1 px-2.5 py-1.5 border border-[#e5e2d0] rounded-lg font-sans text-[12px] ltr-num" />
                  <button onClick={() => saveDoc(docType)} disabled={savingDoc === docType} className="shrink-0 px-3 py-1.5 rounded-lg bg-[#166534] text-white font-sans text-[11.5px] font-bold cursor-pointer disabled:opacity-50">
                    {savingDoc === docType ? t('action.loading') : t('action.save')}
                  </button>
                </div>
                <DonationReceiptUpload bucket="vehicle_compliance_documents" label={t('mv.uploadDocumentLabel')} required={false} onUpload={(path) => saveDocFile(docType, path)} />
              </div>
            )
          })}
        </div>
      </div>

      <button onClick={save} disabled={saving} className="w-full bg-[#166534] text-white rounded-xl py-3 font-sans font-semibold cursor-pointer disabled:opacity-50">
        {saving ? t('action.saving') : t('g.saveChanges')}
      </button>
    </div>
  )
}
