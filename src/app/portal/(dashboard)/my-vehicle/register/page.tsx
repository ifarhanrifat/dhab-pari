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
//
// 2026-10-19: free-text "vehicle type" replaced with a real category
// picker (vehicle_categories, 707) — each category carries its own
// rate+commission card, shown here as a live preview the moment one is
// picked, and a searchable make/model combobox (vehicle_models, 708)
// with an inline "add new" path for a model that isn't listed yet.
//
// Phase 5: re-skinned to the new Mobility design. This page renders
// standalone (the my-vehicle layout's own guard skips its chrome here —
// there's no vehicle yet to drive that chrome), so it keeps its own
// dir wrapper but drops the shop-ink-theme class for the same literal
// hex palette every other re-skinned screen uses.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Car, Clock, XCircle, CheckCircle2, Search, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { usePortalUser } from '@/hooks/usePortalUser'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { DonationReceiptUpload } from '@/components/public/DonationReceiptUpload'

interface RegStatus { id: string; status: 'pending' | 'approved' | 'rejected'; rejection_reason: string | null; created_at: string }
interface VehicleCategory {
  id: string; key: string; name: string; name_ur: string | null; emoji: string; per_km_pkr: number; intercity_commission_pct: number; ride_group: string | null
  vehicle_kind: string | null; min_cc: number | null; max_cc: number | null; example_models_hint: string | null; example_models_hint_ur: string | null
}
interface VehicleModel { id: string; make: string; model: string }

// Real ask, 2026-11-09: "when user is going to register he will pickup
// a model car or write down his car then pickup the cc and when he
// will choose cc then his car will be automatically added into
// category, the committee or admin will only need to verify" — car/
// rickshaw/bike are no longer individual icons in the grid below; they
// open this small sub-form instead, and the real category is resolved
// server-side (resolve_vehicle_category, migration 833) from what's
// entered here. Every other kind (van/bus/loader/tractor/machinery/
// suv) is unchanged — picking it IS the category, same as before.
const KIND_ICONS: Record<'car' | 'rickshaw' | 'bike', string> = { car: '🚗', rickshaw: '🛺', bike: '🛵' }

const emptyForm = {
  owner_name: '', cnic_number: '', father_husband_name: '', address: '',
  category_id: '', vehicle_number: '', model: '', color: '', total_seats: 4,
  owner_id_card_url: '', license_url: '', vehicle_doc_url: '', driver_photo_url: '', has_ac: false,
  wants_delivers: false, wants_hourly: false, wants_shadi: false, wants_out_of_city: false, wants_night_booking: false,
  wants_service_class_ids: [] as string[],
  vehicle_kind: '' as '' | 'car' | 'rickshaw' | 'bike', engine_cc: '', is_electric: false, is_loader: false, is_luxury_declared: false,
}

const inputCls = 'dp2-input'

function fmt(n: number) { return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) }

export default function VehicleRegisterPage() {
  const { t, isUrdu } = useLocale()
  const { user, loading: userLoading } = usePortalUser()
  const router = useRouter()
  const supabase = createClient()

  const [status, setStatus] = useState<RegStatus | null | undefined>(undefined)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [categories, setCategories] = useState<VehicleCategory[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [modelResults, setModelResults] = useState<VehicleModel[]>([])
  const [showAddModel, setShowAddModel] = useState(false)
  const [newMake, setNewMake] = useState('')
  const [newModel, setNewModel] = useState('')
  const [addingModel, setAddingModel] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase.rpc('my_vehicle_registration_status').then(({ data }) => setStatus(data ?? null))
    supabase.from('vehicle_categories').select('id, key, name, name_ur, emoji, per_km_pkr, intercity_commission_pct, ride_group, vehicle_kind, min_cc, max_cc, example_models_hint, example_models_hint_ur').eq('is_active', true).order('display_order').then(({ data }) => setCategories(data ?? []))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handle = setTimeout(() => {
      if (!modelQuery.trim()) { setModelResults([]); return }
      supabase.rpc('vehicle_models_search', { p_query: modelQuery, p_category_id: form.category_id || null }).then(({ data }) => setModelResults((data ?? []) as VehicleModel[]))
    }, 250)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelQuery, form.category_id])

  const pickModel = (m: VehicleModel) => {
    setForm({ ...form, model: `${m.make} ${m.model}` })
    setModelQuery(''); setModelResults([])
  }

  const addNewModel = async () => {
    if (!newMake.trim() || !newModel.trim()) return
    setAddingModel(true)
    const { error } = await supabase.rpc('add_vehicle_model', { p_make: newMake.trim(), p_model: newModel.trim(), p_category_id: form.category_id || null })
    setAddingModel(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vr.modelAddedToast'))
    setForm({ ...form, model: `${newMake.trim()} ${newModel.trim()}` })
    setNewMake(''); setNewModel(''); setShowAddModel(false)
  }

  // Kind/rickshaw/bike are no longer their own rows in `categories` to
  // pick directly — only the "simple" (one-tap) kinds stay in these two
  // grids, same split as before.
  const simpleCategories = categories.filter((c) => !['car', 'rickshaw', 'bike'].includes(c.vehicle_kind ?? ''))
  const sharedRideCategories = simpleCategories.filter((c) => c.ride_group === 'shared_ride')
  const otherCategories = simpleCategories.filter((c) => c.ride_group !== 'shared_ride')

  const [resolvedCategoryId, setResolvedCategoryId] = useState<string | null>(null)
  useEffect(() => {
    if (!form.vehicle_kind) { setResolvedCategoryId(null); return }
    if (form.vehicle_kind === 'car' && !form.engine_cc) { setResolvedCategoryId(null); return }
    const handle = setTimeout(() => {
      supabase.rpc('resolve_vehicle_category', {
        p_kind: form.vehicle_kind, p_cc: form.vehicle_kind === 'car' ? Number(form.engine_cc) : null, p_has_ac: form.vehicle_kind === 'car' ? form.has_ac : null,
        p_is_electric: form.is_electric, p_is_loader: form.is_loader, p_is_luxury: form.is_luxury_declared,
      }).then(({ data }) => setResolvedCategoryId((data as string | null) ?? null))
    }, 300)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.vehicle_kind, form.engine_cc, form.has_ac, form.is_electric, form.is_loader, form.is_luxury_declared])

  const selectedCategory = form.vehicle_kind
    ? (categories.find((c) => c.id === resolvedCategoryId) ?? null)
    : (categories.find((c) => c.id === form.category_id) ?? null)

  const submit = async () => {
    const hasSimplePick = !form.vehicle_kind && !!form.category_id
    const hasKindPick = !!form.vehicle_kind && (form.vehicle_kind !== 'car' || !!form.engine_cc) && !!resolvedCategoryId
    if (!form.owner_name.trim() || !form.cnic_number.trim() || !form.address.trim() || !(hasSimplePick || hasKindPick)) {
      toast.error((hasSimplePick || hasKindPick) ? t('vr.requiredFieldsError') : t('vr.categoryRequiredError')); return
    }
    if (!form.owner_id_card_url || !form.license_url || !form.vehicle_doc_url || !form.driver_photo_url) {
      toast.error(t('vr.allDocumentsRequiredError')); return
    }
    setSubmitting(true)
    const { error } = await supabase.rpc('submit_vehicle_registration', {
      p_owner_name: form.owner_name, p_cnic_number: form.cnic_number, p_father_husband_name: form.father_husband_name || null, p_address: form.address,
      p_vehicle_type: selectedCategory?.name ?? '', p_vehicle_number: form.vehicle_number || null, p_model: form.model || null, p_color: form.color || null, p_total_seats: form.total_seats,
      p_owner_id_card_url: form.owner_id_card_url, p_license_url: form.license_url, p_vehicle_doc_url: form.vehicle_doc_url, p_driver_photo_url: form.driver_photo_url,
      p_wants_delivers: form.wants_delivers, p_wants_hourly: form.wants_hourly, p_wants_shadi: form.wants_shadi, p_wants_out_of_city: form.wants_out_of_city, p_wants_night_booking: form.wants_night_booking,
      p_wants_service_class_ids: form.wants_service_class_ids, p_category_id: form.vehicle_kind ? null : form.category_id, p_has_ac: form.has_ac,
      p_vehicle_kind: form.vehicle_kind || null, p_engine_cc: form.vehicle_kind === 'car' && form.engine_cc ? Number(form.engine_cc) : null,
      p_is_electric: form.is_electric, p_is_loader: form.is_loader, p_is_luxury_declared: form.is_luxury_declared,
    })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('vr.submittedToast'))
    setStatus({ id: '', status: 'pending', rejection_reason: null, created_at: new Date().toISOString() })
  }

  if (userLoading || status === undefined) return <div className="text-center py-12"><LoadingDots /></div>

  if (status?.status === 'pending') {
    return (
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto text-center py-10">
        <Clock size={32} className="text-amber-600 mx-auto mb-3" />
        <h1 className="font-bold text-[20px] sm:text-[22px] text-dp-primary mb-1.5">{t('vr.pendingTitle')}</h1>
        <p className="font-sans text-[13.5px] text-[#64748b]">{t('vr.pendingBody')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-lg mx-auto pb-16 p-3.5">
      <button onClick={() => router.push('/portal/my-vehicle')} className="inline-flex items-center gap-1.5 font-sans text-[13px] font-semibold text-[#166534] mb-4 cursor-pointer">
        <ArrowLeft size={14} className={isUrdu ? 'rotate-180' : ''} /> {t('mp.pageTitle')}
      </button>
      <h1 className="font-bold text-[22px] text-dp-primary flex items-center gap-2 mb-1"><Car size={20} /> {t('vr.pageTitle')}</h1>
      <p className="font-sans text-[13px] text-[#64748b] mb-5">{t('vr.pageSubtitle')}</p>

      {status?.status === 'rejected' && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-3.5 mb-5 flex items-start gap-2">
          <XCircle size={16} className="text-[#b91c1c] shrink-0 mt-0.5" />
          <div>
            <p className="font-sans text-[13px] font-bold text-[#b91c1c]">{t('vr.previouslyRejectedTitle')}</p>
            <p className="font-sans text-[12.5px] text-[#1e293b] mt-0.5">{status.rejection_reason}</p>
            <p className="font-sans text-[12px] text-[#64748b] mt-1.5">{t('vr.resubmitHint')}</p>
          </div>
        </div>
      )}

      <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.ownerInfoHeading')}</p>
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 mb-5 flex flex-col gap-2.5">
        <input value={form.owner_name} onChange={(e) => setForm({ ...form, owner_name: e.target.value })} placeholder={t('vr.ownerNamePlaceholder')} className={inputCls} />
        <input value={form.cnic_number} onChange={(e) => setForm({ ...form, cnic_number: e.target.value })} placeholder={t('vr.cnicPlaceholder')} className={inputCls} />
        <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} placeholder={t('vr.fatherHusbandPlaceholder')} className={inputCls} />
        <textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder={t('vr.addressPlaceholder')} rows={3} className={`${inputCls} resize-none leading-relaxed`} />
      </div>

      <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.categoryPickerLabel')}</p>

      {/* Real ask, 2026-11-09: car/rickshaw/bike are no longer separate
          icons per model/size — one button each opens the small
          cc/electric/loader/luxury sub-form below, and the real
          category is resolved automatically from that, not hand-picked. */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        {(['car', 'rickshaw', 'bike'] as const).map((kind) => {
          const on = form.vehicle_kind === kind
          return (
            <button key={kind} type="button" onClick={() => setForm({ ...form, vehicle_kind: kind, category_id: '' })}
              className="flex flex-col items-center gap-1 py-3 rounded-2xl border-2 cursor-pointer transition-colors"
              style={{ borderColor: on ? '#166534' : '#e5e2d0', background: on ? '#F0FDF4' : '#fff' }}>
              <span className="text-[24px]">{KIND_ICONS[kind]}</span>
              <span className="font-sans text-[10.5px] font-semibold text-[#1e293b] text-center leading-tight">{t(`vr.kind.${kind}`)}</span>
            </button>
          )
        })}
      </div>

      {form.vehicle_kind && (
        <div className="bg-white border border-[#e5e2d0] rounded-2xl p-3.5 mb-4 flex flex-col gap-2.5">
          {form.vehicle_kind === 'car' && (
            <>
              <input type="number" min={50} value={form.engine_cc} onChange={(e) => setForm({ ...form, engine_cc: e.target.value })} placeholder={t('vr.engineCcPlaceholder')} className={inputCls} />
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm({ ...form, has_ac: true })} className="flex-1 py-2 rounded-xl text-[12.5px] font-sans font-bold cursor-pointer" style={{ background: form.has_ac ? '#166534' : '#F9F9F6', color: form.has_ac ? '#fff' : '#64748b' }}>❄️ {t('mv.hasAcLabel')}</button>
                <button type="button" onClick={() => setForm({ ...form, has_ac: false })} className="flex-1 py-2 rounded-xl text-[12.5px] font-sans font-bold cursor-pointer" style={{ background: !form.has_ac ? '#166534' : '#F9F9F6', color: !form.has_ac ? '#fff' : '#64748b' }}>☀️ {t('vr.nonAcLabel')}</button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_electric} onChange={(e) => setForm({ ...form, is_electric: e.target.checked })} className="accent-[#166534]" />
                <span className="font-sans text-[13px] text-[#1e293b]">{t('vr.isElectricLabel')}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_luxury_declared} onChange={(e) => setForm({ ...form, is_luxury_declared: e.target.checked })} className="accent-[#166534]" />
                <span className="font-sans text-[13px] text-[#1e293b]">{t('vr.isLuxuryLabel')}</span>
              </label>
            </>
          )}
          {form.vehicle_kind === 'rickshaw' && (
            <>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form.is_electric} onChange={(e) => setForm({ ...form, is_electric: e.target.checked })} className="accent-[#166534]" />
                <span className="font-sans text-[13px] text-[#1e293b]">{t('vr.isElectricLabel')}</span>
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm({ ...form, is_loader: false })} className="flex-1 py-2 rounded-xl text-[12.5px] font-sans font-bold cursor-pointer" style={{ background: !form.is_loader ? '#166534' : '#F9F9F6', color: !form.is_loader ? '#fff' : '#64748b' }}>🧍 {t('vr.passengerLabel')}</button>
                <button type="button" onClick={() => setForm({ ...form, is_loader: true })} className="flex-1 py-2 rounded-xl text-[12.5px] font-sans font-bold cursor-pointer" style={{ background: form.is_loader ? '#166534' : '#F9F9F6', color: form.is_loader ? '#fff' : '#64748b' }}>📦 {t('vr.loaderLabel')}</button>
              </div>
            </>
          )}
          {form.vehicle_kind === 'bike' && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.is_electric} onChange={(e) => setForm({ ...form, is_electric: e.target.checked })} className="accent-[#166534]" />
              <span className="font-sans text-[13px] text-[#1e293b]">{t('vr.isElectricLabel')}</span>
            </label>
          )}
        </div>
      )}

      {sharedRideCategories.length > 0 && (
        <>
          <p className="font-sans text-[11px] font-bold text-[#166534] uppercase tracking-[0.05em] mb-2">{t('vr.sharedRideHeading')}</p>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {sharedRideCategories.map((c) => {
              const on = !form.vehicle_kind && form.category_id === c.id
              return (
                <button key={c.id} type="button" onClick={() => setForm({ ...form, category_id: c.id, vehicle_kind: '' })}
                  className="flex flex-col items-center gap-1 py-3 rounded-2xl border-2 cursor-pointer transition-colors"
                  style={{ borderColor: on ? '#166534' : '#e5e2d0', background: on ? '#F0FDF4' : '#fff' }}>
                  <span className="text-[24px]">{c.emoji}</span>
                  <span className="font-sans text-[10.5px] font-semibold text-[#1e293b] text-center leading-tight">{isUrdu && c.name_ur ? c.name_ur : c.name}</span>
                </button>
              )
            })}
          </div>
          <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.otherVehiclesHeading')}</p>
        </>
      )}
      <div className="grid grid-cols-4 gap-2 mb-5">
        {otherCategories.map((c) => {
          const on = !form.vehicle_kind && form.category_id === c.id
          return (
            <button key={c.id} type="button" onClick={() => setForm({ ...form, category_id: c.id, vehicle_kind: '' })}
              className="flex flex-col items-center gap-1 py-3 rounded-2xl border-2 cursor-pointer transition-colors"
              style={{ borderColor: on ? '#166534' : '#e5e2d0', background: on ? '#F0FDF4' : '#fff' }}>
              <span className="text-[24px]">{c.emoji}</span>
              <span className="font-sans text-[10.5px] font-semibold text-[#1e293b] text-center leading-tight">{isUrdu && c.name_ur ? c.name_ur : c.name}</span>
            </button>
          )
        })}
      </div>

      {form.vehicle_kind && !selectedCategory && (
        <p className="font-sans text-[12px] text-[#64748b] mb-5">{form.vehicle_kind === 'car' && !form.engine_cc ? t('vr.enterCcHint') : t('vr.noCategoryMatchHint')}</p>
      )}
      {selectedCategory && (
        <div className="bg-[#F0FDF4] border border-[#bbf7d0] rounded-2xl p-3.5 mb-5">
          {form.vehicle_kind && (
            <p className="font-sans text-[12.5px] font-bold text-[#166534] mb-2">{t('vr.resolvedAsLabel')}: {selectedCategory.emoji} {isUrdu && selectedCategory.name_ur ? selectedCategory.name_ur : selectedCategory.name}</p>
          )}
          <p className="font-sans text-[11.5px] font-bold text-[#166534] uppercase tracking-[0.05em] mb-1.5">{t('vr.rateCardHeading')}</p>
          <div className="flex items-center justify-between font-sans text-[13px]">
            <span className="text-[#64748b]">{t('vr.rateCardPerKmLabel')}</span>
            <span className="font-bold text-[#1e293b] ltr-num">₨{fmt(selectedCategory.per_km_pkr)}</span>
          </div>
          <div className="flex items-center justify-between font-sans text-[13px] mt-1">
            <span className="text-[#64748b]">{t('vr.rateCardCommissionLabel')}</span>
            <span className="font-bold text-[#1e293b] ltr-num">{selectedCategory.intercity_commission_pct}%</span>
          </div>
          {(isUrdu ? selectedCategory.example_models_hint_ur : selectedCategory.example_models_hint) && (
            <p className="font-sans text-[11px] text-[#166534] mt-2">{isUrdu ? selectedCategory.example_models_hint_ur : selectedCategory.example_models_hint}</p>
          )}
          <p className="font-sans text-[11px] text-[#64748b] mt-2">{t('vr.rateCardHint')}</p>
        </div>
      )}

      <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.vehicleInfoHeading')}</p>
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 mb-5 flex flex-col gap-2.5">
        <div>
          <div className="relative">
            <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#94a3b8]" />
            <input value={form.model || modelQuery} onChange={(e) => { setModelQuery(e.target.value); setForm({ ...form, model: '' }) }} placeholder={t('vr.modelSearchPlaceholder')} className={`${inputCls} ps-9`} />
          </div>
          {modelResults.length > 0 && !form.model && (
            <div className="border border-[#e5e2d0] rounded-xl mt-1.5 overflow-hidden">
              {modelResults.map((m) => (
                <button key={m.id} type="button" onClick={() => pickModel(m)} className="w-full text-start px-3 py-2 font-sans text-[13px] cursor-pointer hover:bg-[#F9F9F6] border-b border-[#f1f5f9] last:border-0">
                  {m.make} {m.model}
                </button>
              ))}
            </div>
          )}
          {modelQuery.trim() && modelResults.length === 0 && !form.model && (
            <div className="mt-1.5">
              {!showAddModel ? (
                <button type="button" onClick={() => { setShowAddModel(true); setNewModel(modelQuery) }} className="flex items-center gap-1 font-sans text-[12px] font-semibold text-[#166534] cursor-pointer">
                  <Plus size={12} /> {t('vr.modelNotListedHint')} {t('vr.addModelBtn')}
                </button>
              ) : (
                <div className="flex flex-col gap-1.5 border border-[#e5e2d0] rounded-xl p-2.5">
                  <input value={newMake} onChange={(e) => setNewMake(e.target.value)} placeholder={t('vr.newMakePlaceholder')} className={inputCls} />
                  <input value={newModel} onChange={(e) => setNewModel(e.target.value)} placeholder={t('vr.newModelPlaceholder')} className={inputCls} />
                  <button type="button" onClick={addNewModel} disabled={addingModel} className="w-full py-2 rounded-xl bg-[#166534] text-white font-sans text-[12.5px] font-bold cursor-pointer disabled:opacity-50">
                    {addingModel ? t('action.saving') : t('vr.addModelBtn')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} placeholder={t('vr.colorPlaceholder')} className={inputCls} />
          <input value={form.vehicle_number} onChange={(e) => setForm({ ...form, vehicle_number: e.target.value })} placeholder={t('vr.vehicleNumberPlaceholder')} className={inputCls} />
        </div>
        <input type="number" min={1} value={form.total_seats || ''} onChange={(e) => setForm({ ...form, total_seats: +e.target.value })} placeholder={t('vr.totalSeatsPlaceholder')} className={inputCls} />
        {/* Cars already have their own AC/non-AC toggle above (it's
            what decides the category) — this stays only for every
            other kind, where AC is just a vehicle fact, not a
            category-resolving one. */}
        {form.vehicle_kind !== 'car' && (
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={form.has_ac} onChange={(e) => setForm({ ...form, has_ac: e.target.checked })} className="accent-[#166534]" />
          <span className="font-sans text-[13.5px] text-[#1e293b]">{t('mv.hasAcLabel')}</span>
        </label>
        )}
      </div>

      <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.documentsHeading')}</p>
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 mb-5 flex flex-col gap-4">
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.ownerIdCardLabel')} onUpload={(path) => setForm({ ...form, owner_id_card_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.licenseLabel')} onUpload={(path) => setForm({ ...form, license_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.vehicleDocLabel')} onUpload={(path) => setForm({ ...form, vehicle_doc_url: path })} />
        <DonationReceiptUpload bucket="vehicle_registration_documents" label={t('vr.driverPhotoLabel')} onUpload={(path) => setForm({ ...form, driver_photo_url: path })} />
      </div>

      <p className="font-sans text-[11px] font-bold text-[#64748b] uppercase tracking-[0.05em] mb-2">{t('vr.servicesHeading')}</p>
      <div className="bg-white border border-[#e5e2d0] rounded-2xl p-4 mb-6 flex flex-col gap-2.5">
        <p className="font-sans text-[11.5px] text-[#64748b] mb-1 leading-relaxed">{t('vr.servicesHint')}</p>
        {([
          ['wants_delivers', 'vr.wantsDeliversLabel'],
          ['wants_hourly', 'vr.wantsHourlyLabel'],
          ['wants_shadi', 'vr.wantsShadiLabel'],
          ['wants_out_of_city', 'vr.wantsOutOfCityLabel'],
          ['wants_night_booking', 'vr.wantsNightBookingLabel'],
        ] as const).map(([key, labelKey]) => (
          <label key={key} className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="accent-[#166534]" />
            <span className="font-sans text-[13.5px] text-[#1e293b]">{t(labelKey)}</span>
          </label>
        ))}
      </div>


      <button onClick={submit} disabled={submitting} className="w-full flex items-center justify-center gap-1.5 py-3 bg-[#166534] text-white rounded-xl font-sans text-[14px] font-semibold cursor-pointer disabled:opacity-50">
        <CheckCircle2 size={16} /> {submitting ? t('action.saving') : t('vr.submitBtn')}
      </button>
    </div>
  )
}
