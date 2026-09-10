'use client'

// Real driver self-registration — replacing "admin types everything by
// hand, links by guessing a phone number" with what an actual online
// taxi/vehicle registration asks for: owner ID card, license, vehicle
// documents, a driver photo, and which services the driver actually
// wants to offer, submitted from the driver's own logged-in session
// (491) so the eventual vehicles.portal_user_id is never a guess —
// it's just who was signed in when this was submitted. The committee
// verifies documents, confirms village-resident vs outsider, sets
// rates for whatever was requested, and only then does a real vehicle
// row get created (admin_approve_vehicle_registration).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Car, Clock, XCircle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface RegStatus { id: string; status: 'pending' | 'approved' | 'rejected'; rejection_reason: string | null; created_at: string }

const emptyForm = {
  owner_name: '', cnic_number: '', father_husband_name: '', address: '',
  vehicle_type: '', vehicle_number: '', model: '', color: '', total_seats: 4,
  owner_id_card_url: '', license_url: '', vehicle_doc_url: '', driver_photo_url: '',
  wants_delivers: false, wants_hourly: false, wants_shadi: false, wants_out_of_city: false, wants_night_booking: false,
}

export default function VehicleRegisterPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [status, setStatus] = useState<RegStatus | null | undefined>(undefined)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.rpc('my_vehicle_registration_status').then(({ data }) => setStatus(data ?? null))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!form.owner_name.trim() || !form.cnic_number.trim() || !form.address.trim() || !form.vehicle_type.trim()) {
      toast.error(t('vr.requiredFieldsError')); return
    }
    if (!form.owner_id_card_url || !form.license_url || !form.vehicle_doc_url || !form.driver_photo_url) {
      toast.error(t('vr.allDocumentsRequiredError')); return
    }
    setSubmitting(true)
    const { error } = await supabase.rpc('submit_vehicle_registration', {
      p_owner_name: form.owner_name, p_cnic_number: form.cnic_number, p_father_husband_name: form.father_husband_name || null, p_address: form.address,
      p_vehicle_type: form.vehicle_type, p_vehicle_number: form.vehicle_number || null, p_model: form.model || null, p_color: form.color || null, p_total_seats: form.total_seats,
      p_owner_id_card_url: form.owner_id_card_url, p_license_url: form.license_url, p_vehicle_doc_url: form.vehicle_doc_url, p_driver_photo_url: form.driver_photo_url,
      p_wants_delivers: form.wants_delivers, p_wants_hourly: form.wants_hourly, p_wants_shadi: form.wants_shadi, p_wants_out_of_city: form.wants_out_of_city, p_wants_night_booking: form.wants_night_booking,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vr.submittedToast'))
    setStatus({ id: '', status: 'pending', rejection_reason: null, created_at: new Date().toISOString() })
  }

  if (userLoading || status === undefined) return <div className="text-center py-12 text-dp-on-surface-variant font-sans"><LoadingDots /></div>

  if (status?.status === 'pending') {
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme max-w-lg mx-auto text-center py-10">
        <Clock size={32} className="text-amber-600 mx-auto mb-3" />
        <h1 className="font-heading text-[20px] font-bold text-dp-primary mb-1.5">{t('vr.pendingTitle')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant">{t('vr.pendingBody')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="shop-ink-theme max-w-lg mx-auto pb-16">
      <button onClick={() => router.push('/portal/my-vehicle')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-dp-secondary hover:underline mb-4 cursor-pointer">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.pageTitle')}
      </button>
      <h1 className="font-heading text-[24px] font-bold text-dp-primary flex items-center gap-2 mb-1"><Car size={20} /> {t('vr.pageTitle')}</h1>
      <p className="font-sans text-[13px] text-dp-on-surface-variant mb-5">{t('vr.pageSubtitle')}</p>

      {status?.status === 'rejected' && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3.5 mb-5 flex items-start gap-2">
          <XCircle size={16} className="text-dp-error shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[13px] font-bold text-dp-error">{t('vr.previouslyRejectedTitle')}</p>
            <p className="font-sans text-[12.5px] text-dp-on-surface mt-0.5">{status.rejection_reason}</p>
            <p className="font-sans text-[12px] text-dp-on-surface-variant mt-1.5">{t('vr.resubmitHint')}</p>
          </div>
        </div>
      )}

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vr.ownerInfoHeading')}</p>
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5 space-y-2.5">
        <input value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} placeholder={t('vr.ownerNamePlaceholder')} className="input-field" />
        <input value={form.cnic_number} onChange={(e) => setForm({ ...form, cnic_number: e.target.value })} placeholder={t('vr.cnicPlaceholder')} className="input-field" />
        <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} placeholder={t('vr.fatherHusbandPlaceholder')} className="input-field" />
        <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('vr.addressPlaceholder')} rows={2} className="input-field resize-none" />
      </div>

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vr.vehicleInfoHeading')}</p>
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5 space-y-2.5">
        <input value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })} placeholder={t('vr.vehicleTypePlaceholder')} className="input-field" />
        <div className="grid grid-cols-2 gap-2.5">
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={t('vr.modelPlaceholder')} className="input-field" />
          <input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} placeholder={t('vr.colorPlaceholder')} className="input-field" />
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <input value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} placeholder={t('vr.vehicleNumberPlaceholder')} className="input-field" />
          <input type="number" min={1} value={form.total_seats || ''} onChange={(e) => setForm({ ...form, total_seats: +e.target.value })} placeholder={t('vr.totalSeatsPlaceholder')} className="input-field" />
        </div>
      </div>

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vr.documentsHeading')}</p>
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-5 space-y-4">
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.ownerIdCardLabel')} onUpload={(path) => setForm({ ...form, owner_id_card_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.licenseLabel')} onUpload={(path) => setForm({ ...form, license_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.vehicleDocLabel')} onUpload={(path) => setForm({ ...form, vehicle_doc_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.driverPhotoLabel')} onUpload={(path) => setForm({ ...form, driver_photo_url: path })} />
      </div>

      <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-[0.05em] mb-2.5">{t('vr.servicesHeading')}</p>
      <div className="bg-white border border-dp-outline-variant rounded-lg p-4 mb-6 space-y-2.5">
        <p className="font-sans text-[11.5px] text-dp-on-surface-variant mb-1">{t('vr.servicesHint')}</p>
        {([
          ['wants_delivers', 'vr.wantsDeliversLabel'],
          ['wants_hourly', 'vr.wantsHourlyLabel'],
          ['wants_shadi', 'vr.wantsShadiLabel'],
          ['wants_out_of_city', 'vr.wantsOutOfCityLabel'],
          ['wants_night_booking', 'vr.wantsNightBookingLabel'],
        ] as const).map(([key, labelKey]) => (
          <label key={key} className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="accent-dp-secondary" />
            <span className="font-sans text-[13.5px] text-dp-on-surface">{t(labelKey)}</span>
          </label>
        ))}
      </div>

      <button onClick={submit} disabled={submitting} className="w-full flex items-center justify-center gap-1.5 py-3 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
        <CheckCircle2 size={16} /> {submitting ? t('action.saving') : t('vr.submitBtn')}
      </button>
    </div>
  )
}
