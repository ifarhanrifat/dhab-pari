'use client'

// Committee review queue for driver self-registration (491) — real
// documents, a real approval gate, and the vehicle only ever gets
// created here with portal_user_id already correct (proven by the
// driver's own session at submission time, not a phone number an
// admin typed and hoped matched). Documents are in a private bucket;
// viewed via short-lived signed URLs, same shape every other private-
// proof screen in this app already uses.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { UserCheck, FileImage, CheckCircle2, XCircle, Phone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Request {
  id: string; owner_name: string; cnic_number: string; father_husband_name: string | null; address: string
  vehicle_type: string; vehicle_number: string | null; model: string | null; color: string | null; has_ac: boolean; total_seats: number
  owner_id_card_url: string; license_url: string; vehicle_doc_url: string; driver_photo_url: string
  wants_delivers: boolean; wants_hourly: boolean; wants_shadi: boolean; wants_out_of_city: boolean; wants_night_booking: boolean
  status: 'pending' | 'approved' | 'rejected'; is_village_resident: boolean | null; rejection_reason: string | null
  created_at: string; reviewed_at: string | null; submitter_name: string; submitter_mobile: string | null
  category_id: string | null; category_name: string | null; category_name_ur: string | null; category_emoji: string | null
  category_vehicle_kind: string | null; category_min_cc: number | null; category_max_cc: number | null
  category_per_km_pkr: number | null; category_out_of_city_per_km_pkr: number | null
  category_hourly_rate_pkr: number | null; category_hourly_included_km: number | null; category_hourly_overage_per_km_pkr: number | null
  category_shadi_full_day_rate_pkr: number | null
  engine_cc: number | null; is_electric: boolean; is_loader: boolean; is_luxury_declared: boolean
}

const DOC_FIELDS = [
  ['owner_id_card', 'vr.ownerIdCardLabel'], ['license', 'vr.licenseLabel'],
  ['vehicle_doc', 'vr.vehicleDocLabel'], ['driver_photo', 'vr.driverPhotoLabel'],
] as const

export default function AdminVehicleRegistrationsPage() {
  const { t, isUrdu } = useLocale()
  const access = useSystemAccess()
  const supabase = createClient()

  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [rows, setRows] = useState<Request[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [docUrls, setDocUrls] = useState<Record<string, string>>({})
  const [isVillageResident, setIsVillageResident] = useState(true)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (status: typeof tab) => {
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_list_vehicle_registrations', { p_status: status })
    if (error) toast.error(friendlyError(error, undefined, isUrdu))
    setRows((data ?? []) as Request[])
    setLoading(false)
  }
  useEffect(() => { load(tab) }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const expand = async (r: Request) => {
    if (expandedId === r.id) { setExpandedId(null); return }
    setExpandedId(r.id); setIsVillageResident(true); setRejectingId(null)
    const urls: Record<string, string> = {}
    await Promise.all(DOC_FIELDS.map(async ([which]) => {
      const { data: path } = await supabase.rpc('admin_vehicle_registration_document_path', { p_request_id: r.id, p_which: which })
      if (path) {
        const { data: signed } = await supabase.storage.from('vehicle_registration_documents').createSignedUrl(path, 300)
        if (signed) urls[which] = signed.signedUrl
      }
    }))
    setDocUrls(urls)
  }

  const approve = async (r: Request) => {
    setSaving(true)
    const { error } = await supabase.rpc('admin_approve_vehicle_registration', {
      p_request_id: r.id, p_is_village_resident: isVillageResident, p_category_id: r.category_id,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vreg.approvedToast'))
    setExpandedId(null)
    load(tab)
  }
  const reject = async (r: Request) => {
    if (!rejectReason.trim()) { toast.error(t('vreg.reasonRequiredError')); return }
    setSaving(true)
    const { error } = await supabase.rpc('admin_reject_vehicle_registration', { p_request_id: r.id, p_reason: rejectReason.trim() })
    setSaving(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vreg.rejectedToast'))
    setExpandedId(null); setRejectReason('')
    load(tab)
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>
  if (!access.canDonorsProjects) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center"><p className="font-sans text-[14px] text-dp-on-surface-variant">{t('vreg.noAccessMessage')}</p></div>
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme">
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><UserCheck size={26} /> {t('vreg.pageTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">{t('vreg.pageSubtitle')}</p>
      </div>

      <div className="flex items-center gap-1 bg-dp-surface-container rounded-lg p-1 mb-5 w-fit">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <button key={s} onClick={() => setTab(s)} className={`px-4 py-2 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${tab === s ? 'bg-white text-dp-primary shadow-sm' : 'text-dp-on-surface-variant'}`}>{t(`vreg.tab.${s}`)}</button>
        ))}
      </div>

      {loading && <p className="font-sans text-[13.5px] text-dp-on-surface-variant"><LoadingDots /></p>}
      {!loading && rows.length === 0 && <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('vreg.noResults')}</p>}

      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <button onClick={() => expand(r)} className="w-full text-start cursor-pointer">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface">{r.owner_name} <span className="font-normal text-dp-on-surface-variant">· {r.category_emoji ? `${r.category_emoji} ` : ''}{isUrdu && r.category_name_ur ? r.category_name_ur : (r.category_name ?? r.vehicle_type)}{r.vehicle_number ? ` · ${r.vehicle_number}` : ''}</span></p>
                  <p className="font-sans text-[12px] text-dp-on-surface-variant mt-0.5">{t('vreg.submittedByLabel')}: {r.submitter_name}{r.submitter_mobile ? ` · ${r.submitter_mobile}` : ''}</p>
                  <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-0.5">{new Date(r.created_at).toLocaleDateString('en-GB')}</p>
                </div>
                {r.status === 'rejected' && r.rejection_reason && <p className="font-sans text-[12px] text-dp-error max-w-[200px]">{r.rejection_reason}</p>}
              </div>
            </button>

            {expandedId === r.id && (
              <div className="mt-3 pt-3 border-t border-dp-outline-variant space-y-3">
                <div className="grid grid-cols-2 gap-2 font-sans text-[12.5px]">
                  <p><span className="text-dp-on-surface-variant">{t('vr.cnicPlaceholder')}:</span> <span className="font-semibold ltr-num">{r.cnic_number}</span></p>
                  {r.father_husband_name && <p><span className="text-dp-on-surface-variant">{t('vr.fatherHusbandPlaceholder')}:</span> <span className="font-semibold">{r.father_husband_name}</span></p>}
                  <p className="col-span-2"><span className="text-dp-on-surface-variant">{t('vr.addressPlaceholder')}:</span> <span className="font-semibold">{r.address}</span></p>
                  <p><span className="text-dp-on-surface-variant">{t('vr.modelPlaceholder')}:</span> <span className="font-semibold">{r.model ?? '—'}</span></p>
                  <p><span className="text-dp-on-surface-variant">{t('vr.colorPlaceholder')}:</span> <span className="font-semibold">{r.color ?? '—'}</span></p>
                  <p><span className="text-dp-on-surface-variant">{t('vr.totalSeatsPlaceholder')}:</span> <span className="font-semibold ltr-num">{r.total_seats}</span></p>
                  <p><span className="text-dp-on-surface-variant">{t('mv.hasAcLabel')}:</span> <span className="font-semibold">{r.has_ac ? t('g.yes') : t('g.no')}</span></p>
                  {r.category_vehicle_kind && ['car', 'rickshaw', 'bike'].includes(r.category_vehicle_kind) && (
                    <>
                      {r.engine_cc != null && <p><span className="text-dp-on-surface-variant">{t('vreg.engineCcLabel')}:</span> <span className="font-semibold ltr-num">{r.engine_cc}cc</span></p>}
                      <p><span className="text-dp-on-surface-variant">{t('vreg.declaredFlagsLabel')}:</span> <span className="font-semibold">
                        {[r.is_electric && t('vr.isElectricLabel'), r.is_loader && t('vr.loaderLabel'), r.is_luxury_declared && t('vr.isLuxuryLabel')].filter(Boolean).join(', ') || '—'}
                      </span></p>
                    </>
                  )}
                  {r.submitter_mobile && <a href={`tel:${r.submitter_mobile}`} className="inline-flex items-center gap-1 text-dp-secondary font-semibold"><Phone size={12} /> {r.submitter_mobile}</a>}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {r.wants_delivers && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('vr.wantsDeliversLabel')}</span>}
                  {r.wants_hourly && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('vr.wantsHourlyLabel')}</span>}
                  {r.wants_shadi && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('vr.wantsShadiLabel')}</span>}
                  {r.wants_out_of_city && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('vr.wantsOutOfCityLabel')}</span>}
                  {r.wants_night_booking && <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-dp-surface-container-high text-dp-on-surface-variant">{t('vr.wantsNightBookingLabel')}</span>}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {DOC_FIELDS.map(([which, labelKey]) => (
                    <a key={which} href={docUrls[which]} target="_blank" rel="noopener noreferrer" className={`flex flex-col items-center gap-1 border border-dp-outline-variant rounded-lg p-2 text-center hover:border-dp-secondary transition-colors ${!docUrls[which] ? 'pointer-events-none opacity-40' : ''}`}>
                      <FileImage size={18} className="text-dp-secondary" />
                      <span className="font-sans text-[10.5px] font-semibold text-dp-on-surface">{t(labelKey)}</span>
                    </a>
                  ))}
                </div>

                {r.status === 'pending' && (
                  <>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={isVillageResident} onChange={(e) => setIsVillageResident(e.target.checked)} className="accent-dp-secondary" />
                      <span className="font-sans text-[13px] font-semibold">{t('vreg.isVillageResidentLabel')}</span>
                    </label>

                    {/* Real ask, 2026-11-10: "no manual input for the
                        admin end — just attach a category, that's it."
                        Every rate the driver's requested services need
                        (delivery/hourly/shadi) now comes straight off
                        the resolved category's own fare card — nothing
                        left to type. This is a read-only preview of
                        exactly what approving will set, and a clear
                        block (not a silent NULL) if the category is
                        missing a rate a requested service needs. */}
                    {(r.wants_delivers || r.wants_hourly || r.wants_shadi || r.wants_out_of_city) && (
                      <div className="bg-dp-surface-container rounded-lg p-3 flex flex-col gap-1.5">
                        <p className="font-sans text-[11px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em]">{t('vreg.categoryFareCardLabel')}</p>
                        {r.wants_delivers && (
                          <p className="font-sans text-[12.5px]">
                            {t('vr.wantsDeliversLabel')}: {r.category_per_km_pkr ? <span className="font-semibold ltr-num">₨{r.category_per_km_pkr}/km</span> : <span className="text-dp-error font-semibold">{t('vreg.rateNotSetLabel')}</span>}
                          </p>
                        )}
                        {r.wants_out_of_city && (
                          <p className="font-sans text-[12.5px]">
                            {t('vr.wantsOutOfCityLabel')}: {r.category_out_of_city_per_km_pkr ? <span className="font-semibold ltr-num">₨{r.category_out_of_city_per_km_pkr}/km</span> : <span className="text-dp-error font-semibold">{t('vreg.rateNotSetLabel')}</span>}
                          </p>
                        )}
                        {r.wants_hourly && (
                          <p className="font-sans text-[12.5px]">
                            {t('vr.wantsHourlyLabel')}: {r.category_hourly_rate_pkr && r.category_hourly_included_km != null && r.category_hourly_overage_per_km_pkr != null
                              ? <span className="font-semibold ltr-num">₨{r.category_hourly_rate_pkr}/hr · {r.category_hourly_included_km}km incl. · ₨{r.category_hourly_overage_per_km_pkr}/km over</span>
                              : <span className="text-dp-error font-semibold">{t('vreg.rateNotSetLabel')}</span>}
                          </p>
                        )}
                        {r.wants_shadi && (
                          <p className="font-sans text-[12.5px]">
                            {t('vr.wantsShadiLabel')}: {r.category_shadi_full_day_rate_pkr ? <span className="font-semibold ltr-num">₨{r.category_shadi_full_day_rate_pkr}/day</span> : <span className="text-dp-error font-semibold">{t('vreg.rateNotSetLabel')}</span>}
                          </p>
                        )}
                        <p className="font-sans text-[10.5px] text-dp-on-surface-variant mt-0.5">{t('vreg.categoryFareCardHint')}</p>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button onClick={() => approve(r)} disabled={saving} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-dp-secondary text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary disabled:opacity-50"><CheckCircle2 size={15} /> {t('vreg.approveBtn')}</button>
                      <button onClick={() => setRejectingId(rejectingId === r.id ? null : r.id)} className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-dp-error text-dp-error rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-red-50"><XCircle size={15} /> {t('vreg.rejectBtn')}</button>
                    </div>
                    {rejectingId === r.id && (
                      <div className="flex gap-2">
                        <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('vreg.reasonPlaceholder')} className="input-field flex-1" />
                        <button onClick={() => reject(r)} disabled={saving} className="px-3.5 py-2 bg-dp-error text-white rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:opacity-90 disabled:opacity-50">{t('vreg.confirmRejectBtn')}</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
