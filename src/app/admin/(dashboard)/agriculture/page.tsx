'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Sprout, Landmark, Building2, PawPrint } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface DiseaseGuide {
  id: string; crop: string; crop_ur: string; disease_name: string; disease_name_ur: string
  symptoms: string | null; symptoms_ur: string | null; spray_timing: string | null; spray_timing_ur: string | null
  prevention: string | null; prevention_ur: string | null; display_order: number; is_active: boolean
}
interface Scheme {
  id: string; title: string; title_ur: string; description: string | null; description_ur: string | null
  department: string | null; eligibility: string | null; eligibility_ur: string | null; amount: string | null
  districts: string | null; status: string; deadline: string | null; official_url: string | null
  last_verified_at: string; display_order: number; is_active: boolean
}
interface HelpCenter {
  id: string; name: string; name_ur: string; what_they_offer: string | null; what_they_offer_ur: string | null
  phone: string | null; address: string | null; address_ur: string | null; category: string; display_order: number; is_active: boolean
}
interface LivestockGuide {
  id: string; animal: string; animal_ur: string; topic_name: string; topic_name_ur: string
  details: string | null; details_ur: string | null; timing: string | null; timing_ur: string | null
  care_tips: string | null; care_tips_ur: string | null; display_order: number; is_active: boolean
}

const emptyDisease = {
  crop: '', crop_ur: '', disease_name: '', disease_name_ur: '', symptoms: '', symptoms_ur: '',
  spray_timing: '', spray_timing_ur: '', prevention: '', prevention_ur: '', display_order: 0, is_active: true,
}
const emptyScheme = {
  title: '', title_ur: '', description: '', description_ur: '', department: '', eligibility: '', eligibility_ur: '',
  amount: '', districts: '', status: 'open', deadline: '', official_url: '',
  last_verified_at: new Date().toISOString().slice(0, 10), display_order: 0, is_active: true,
}
const emptyCenter = {
  name: '', name_ur: '', what_they_offer: '', what_they_offer_ur: '', phone: '', address: '', address_ur: '',
  category: 'agriculture', display_order: 0, is_active: true,
}
const emptyLivestock = {
  animal: '', animal_ur: '', topic_name: '', topic_name_ur: '', details: '', details_ur: '',
  timing: '', timing_ur: '', care_tips: '', care_tips_ur: '', display_order: 0, is_active: true,
}

const STATUSES = ['open', 'upcoming', 'closed']
const HELP_CENTER_CATEGORIES = ['agriculture', 'livestock']

// Phase 3 of the "Village OS" feature set, 2026-10-02. One control room
// for the whole Agriculture Hub's admin-curated content -- deliberately
// three tabs in one page rather than three separate sidebar entries, same
// consolidation principle already applied to /admin/notifications. Crop
// prices keep their own existing page (ag.* keys already in use there);
// these three are new content types, prefixed agh.* instead.
export default function AdminAgriculturePage() {
  const { t, isUrdu } = useLocale()
  const [tab, setTab] = useState<'diseases' | 'schemes' | 'centers' | 'livestock'>('schemes')
  const supabase = createClient()

  // ── Disease guides ──────────────────────────────────────────────────
  const [diseases, setDiseases] = useState<DiseaseGuide[]>([])
  const [loadingDiseases, setLoadingDiseases] = useState(true)
  const [diseaseForm, setDiseaseForm] = useState(emptyDisease)
  const [showDiseaseForm, setShowDiseaseForm] = useState(false)
  const [editingDisease, setEditingDisease] = useState<string | null>(null)

  const loadDiseases = async () => {
    const { data } = await supabase.from('ag_disease_guides').select('*').order('crop').order('display_order')
    setDiseases((data ?? []) as DiseaseGuide[]); setLoadingDiseases(false)
  }
  const saveDisease = async () => {
    if (!diseaseForm.crop.trim() || !diseaseForm.disease_name.trim()) { toast.error(t('agh.fillRequired')); return }
    const payload = { ...diseaseForm }
    const { error } = editingDisease
      ? await supabase.from('ag_disease_guides').update(payload).eq('id', editingDisease)
      : await supabase.from('ag_disease_guides').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editingDisease ? t('agh.updated') : t('agh.added'))
    setShowDiseaseForm(false); setEditingDisease(null); setDiseaseForm(emptyDisease); loadDiseases()
  }
  const editDisease = (d: DiseaseGuide) => {
    setDiseaseForm({
      crop: d.crop, crop_ur: d.crop_ur, disease_name: d.disease_name, disease_name_ur: d.disease_name_ur,
      symptoms: d.symptoms ?? '', symptoms_ur: d.symptoms_ur ?? '', spray_timing: d.spray_timing ?? '', spray_timing_ur: d.spray_timing_ur ?? '',
      prevention: d.prevention ?? '', prevention_ur: d.prevention_ur ?? '', display_order: d.display_order, is_active: d.is_active,
    })
    setEditingDisease(d.id); setShowDiseaseForm(true)
  }
  const removeDisease = async (id: string) => { if (!confirm(t('agh.confirmDelete'))) return; await supabase.from('ag_disease_guides').delete().eq('id', id); toast.success(t('agh.deleted')); loadDiseases() }

  // ── Schemes ──────────────────────────────────────────────────────────
  const [schemes, setSchemes] = useState<Scheme[]>([])
  const [loadingSchemes, setLoadingSchemes] = useState(true)
  const [schemeForm, setSchemeForm] = useState(emptyScheme)
  const [showSchemeForm, setShowSchemeForm] = useState(false)
  const [editingScheme, setEditingScheme] = useState<string | null>(null)

  const loadSchemes = async () => {
    const { data } = await supabase.from('ag_schemes').select('*').order('display_order').order('created_at', { ascending: false })
    setSchemes((data ?? []) as Scheme[]); setLoadingSchemes(false)
  }
  const saveScheme = async () => {
    if (!schemeForm.title.trim() || !schemeForm.title_ur.trim()) { toast.error(t('agh.fillRequired')); return }
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const payload = {
      ...schemeForm,
      deadline: schemeForm.deadline || null,
      official_url: schemeForm.official_url.trim() || null,
      created_by_admin_user_id: me?.id,
    }
    const { error } = editingScheme
      ? await supabase.from('ag_schemes').update(payload).eq('id', editingScheme)
      : await supabase.from('ag_schemes').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editingScheme ? t('agh.updated') : t('agh.added'))
    setShowSchemeForm(false); setEditingScheme(null); setSchemeForm(emptyScheme); loadSchemes()
  }
  const editScheme = (s: Scheme) => {
    setSchemeForm({
      title: s.title, title_ur: s.title_ur, description: s.description ?? '', description_ur: s.description_ur ?? '',
      department: s.department ?? '', eligibility: s.eligibility ?? '', eligibility_ur: s.eligibility_ur ?? '',
      amount: s.amount ?? '', districts: s.districts ?? '', status: s.status, deadline: s.deadline ?? '',
      official_url: s.official_url ?? '', last_verified_at: s.last_verified_at, display_order: s.display_order, is_active: s.is_active,
    })
    setEditingScheme(s.id); setShowSchemeForm(true)
  }
  const removeScheme = async (id: string) => { if (!confirm(t('agh.confirmDelete'))) return; await supabase.from('ag_schemes').delete().eq('id', id); toast.success(t('agh.deleted')); loadSchemes() }
  // One click, not a full re-edit -- this is the field admins will touch
  // most often (re-checking the official source without anything else
  // having changed).
  const markVerifiedToday = async (id: string) => {
    await supabase.from('ag_schemes').update({ last_verified_at: new Date().toISOString().slice(0, 10) }).eq('id', id)
    toast.success(t('agh.markedVerified')); loadSchemes()
  }

  // ── Help centers ─────────────────────────────────────────────────────
  const [centers, setCenters] = useState<HelpCenter[]>([])
  const [loadingCenters, setLoadingCenters] = useState(true)
  const [centerForm, setCenterForm] = useState(emptyCenter)
  const [showCenterForm, setShowCenterForm] = useState(false)
  const [editingCenter, setEditingCenter] = useState<string | null>(null)

  const loadCenters = async () => {
    const { data } = await supabase.from('ag_help_centers').select('*').order('display_order').order('name')
    setCenters((data ?? []) as HelpCenter[]); setLoadingCenters(false)
  }
  const saveCenter = async () => {
    if (!centerForm.name.trim() || !centerForm.name_ur.trim()) { toast.error(t('agh.fillRequired')); return }
    const payload = { ...centerForm }
    const { error } = editingCenter
      ? await supabase.from('ag_help_centers').update(payload).eq('id', editingCenter)
      : await supabase.from('ag_help_centers').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editingCenter ? t('agh.updated') : t('agh.added'))
    setShowCenterForm(false); setEditingCenter(null); setCenterForm(emptyCenter); loadCenters()
  }
  const editCenter = (c: HelpCenter) => {
    setCenterForm({
      name: c.name, name_ur: c.name_ur, what_they_offer: c.what_they_offer ?? '', what_they_offer_ur: c.what_they_offer_ur ?? '',
      phone: c.phone ?? '', address: c.address ?? '', address_ur: c.address_ur ?? '', category: c.category, display_order: c.display_order, is_active: c.is_active,
    })
    setEditingCenter(c.id); setShowCenterForm(true)
  }
  const removeCenter = async (id: string) => { if (!confirm(t('agh.confirmDelete'))) return; await supabase.from('ag_help_centers').delete().eq('id', id); toast.success(t('agh.deleted')); loadCenters() }

  // ── Livestock guides ─────────────────────────────────────────────────
  // Same shape as disease guides, generalized from "disease" to "topic"
  // so one table covers health, vaccination schedules, and feeding
  // instead of three near-identical ones.
  const [livestock, setLivestock] = useState<LivestockGuide[]>([])
  const [loadingLivestock, setLoadingLivestock] = useState(true)
  const [livestockForm, setLivestockForm] = useState(emptyLivestock)
  const [showLivestockForm, setShowLivestockForm] = useState(false)
  const [editingLivestock, setEditingLivestock] = useState<string | null>(null)

  const loadLivestock = async () => {
    const { data } = await supabase.from('ag_livestock_guides').select('*').order('animal').order('display_order')
    setLivestock((data ?? []) as LivestockGuide[]); setLoadingLivestock(false)
  }
  const saveLivestock = async () => {
    if (!livestockForm.animal.trim() || !livestockForm.topic_name.trim()) { toast.error(t('agh.fillRequired')); return }
    const payload = { ...livestockForm }
    const { error } = editingLivestock
      ? await supabase.from('ag_livestock_guides').update(payload).eq('id', editingLivestock)
      : await supabase.from('ag_livestock_guides').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(editingLivestock ? t('agh.updated') : t('agh.added'))
    setShowLivestockForm(false); setEditingLivestock(null); setLivestockForm(emptyLivestock); loadLivestock()
  }
  const editLivestock = (l: LivestockGuide) => {
    setLivestockForm({
      animal: l.animal, animal_ur: l.animal_ur, topic_name: l.topic_name, topic_name_ur: l.topic_name_ur,
      details: l.details ?? '', details_ur: l.details_ur ?? '', timing: l.timing ?? '', timing_ur: l.timing_ur ?? '',
      care_tips: l.care_tips ?? '', care_tips_ur: l.care_tips_ur ?? '', display_order: l.display_order, is_active: l.is_active,
    })
    setEditingLivestock(l.id); setShowLivestockForm(true)
  }
  const removeLivestock = async (id: string) => { if (!confirm(t('agh.confirmDelete'))) return; await supabase.from('ag_livestock_guides').delete().eq('id', id); toast.success(t('agh.deleted')); loadLivestock() }

  useEffect(() => { loadDiseases(); loadSchemes(); loadCenters(); loadLivestock() }, [])

  const TABS: { key: typeof tab; label: string; icon: typeof Sprout }[] = [
    { key: 'schemes', label: t('agh.tabSchemes'), icon: Landmark },
    { key: 'diseases', label: t('agh.tabDiseases'), icon: Sprout },
    { key: 'livestock', label: t('agh.tabLivestock'), icon: PawPrint },
    { key: 'centers', label: t('agh.tabCenters'), icon: Building2 },
  ]

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2 mb-2"><Sprout size={26} /> {t('agh.adminTitle')}</h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6">{t('agh.adminIntro')}</p>

      <div className="flex gap-2 mb-6 border-b border-dp-outline-variant">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-4 py-2.5 font-sans text-[13.5px] font-semibold cursor-pointer border-b-2 transition-all ${tab === key ? 'border-dp-secondary text-dp-primary' : 'border-transparent text-dp-on-surface-variant hover:text-dp-on-surface'}`}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {/* ── Schemes tab ── */}
      {tab === 'schemes' && (
        <div>
          <button onClick={() => { setSchemeForm(emptyScheme); setEditingScheme(null); setShowSchemeForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-4"><PlusCircle size={16} /> {t('agh.addScheme')}</button>
          <div className="space-y-3">
            {loadingSchemes && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
            {!loadingSchemes && schemes.map((s) => (
              <div key={s.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans ${s.status === 'open' ? 'bg-emerald-100 text-emerald-700' : s.status === 'upcoming' ? 'bg-blue-100 text-blue-700' : 'bg-dp-surface-container-high text-dp-on-surface-variant'}`}>{t(`agh.status.${s.status}`)}</span>
                    <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{s.title}</h3>
                    <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('agh.lastVerified')}: <span className="ltr-num">{s.last_verified_at}</span></p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => markVerifiedToday(s.id)} className="px-2.5 py-1.5 text-[12px] font-sans font-semibold text-emerald-700 border border-emerald-200 rounded-lg cursor-pointer hover:bg-emerald-50">{t('agh.verifyToday')}</button>
                    <button onClick={() => editScheme(s)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
                    <button onClick={() => removeScheme(s.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
                  </div>
                </div>
              </div>
            ))}
            {!loadingSchemes && schemes.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('agh.empty')}</p>}
          </div>
        </div>
      )}

      {/* ── Disease guides tab ── */}
      {tab === 'diseases' && (
        <div>
          <button onClick={() => { setDiseaseForm(emptyDisease); setEditingDisease(null); setShowDiseaseForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-4"><PlusCircle size={16} /> {t('agh.addDisease')}</button>
          <div className="space-y-3">
            {loadingDiseases && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
            {!loadingDiseases && diseases.map((d) => (
              <div key={d.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{d.crop}</span>
                  <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{d.disease_name}</h3>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => editDisease(d)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
                  <button onClick={() => removeDisease(d.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
            {!loadingDiseases && diseases.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('agh.empty')}</p>}
          </div>
        </div>
      )}

      {/* ── Help centers tab ── */}
      {tab === 'centers' && (
        <div>
          <button onClick={() => { setCenterForm(emptyCenter); setEditingCenter(null); setShowCenterForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-4"><PlusCircle size={16} /> {t('agh.addCenter')}</button>
          <div className="space-y-3">
            {loadingCenters && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
            {!loadingCenters && centers.map((c) => (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`agh.hcCat.${c.category}`)}</span>
                  <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{c.name}</h3>
                  {c.phone && <p className="font-sans text-[12.5px] text-dp-on-surface-variant ltr-num">{c.phone}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => editCenter(c)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
                  <button onClick={() => removeCenter(c.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
            {!loadingCenters && centers.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('agh.empty')}</p>}
          </div>
        </div>
      )}

      {/* ── Livestock guides tab ── */}
      {tab === 'livestock' && (
        <div>
          <button onClick={() => { setLivestockForm(emptyLivestock); setEditingLivestock(null); setShowLivestockForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all mb-4"><PlusCircle size={16} /> {t('agh.addLivestock')}</button>
          <div className="space-y-3">
            {loadingLivestock && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
            {!loadingLivestock && livestock.map((l) => (
              <div key={l.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{l.animal}</span>
                  <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{l.topic_name}</h3>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => editLivestock(l)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
                  <button onClick={() => removeLivestock(l.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
            {!loadingLivestock && livestock.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('agh.empty')}</p>}
          </div>
        </div>
      )}

      {/* ── Scheme form modal ── */}
      {showSchemeForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowSchemeForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingScheme ? t('agh.editScheme') : t('agh.addScheme')}</h2><button onClick={() => setShowSchemeForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <input placeholder={t('ve.titleEn')} value={schemeForm.title} onChange={(e) => setSchemeForm({ ...schemeForm, title: e.target.value })} className="input-field" />
              <input placeholder={t('ve.titleUr')} value={schemeForm.title_ur} onChange={(e) => setSchemeForm({ ...schemeForm, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.descriptionEn')} value={schemeForm.description} onChange={(e) => setSchemeForm({ ...schemeForm, description: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.descriptionUr')} value={schemeForm.description_ur} onChange={(e) => setSchemeForm({ ...schemeForm, description_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <input placeholder={t('agh.department')} value={schemeForm.department} onChange={(e) => setSchemeForm({ ...schemeForm, department: e.target.value })} className="input-field" />
              <textarea placeholder={t('agh.eligibilityEn')} value={schemeForm.eligibility} onChange={(e) => setSchemeForm({ ...schemeForm, eligibility: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.eligibilityUr')} value={schemeForm.eligibility_ur} onChange={(e) => setSchemeForm({ ...schemeForm, eligibility_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <div className="grid grid-cols-2 gap-3">
                <input placeholder={t('agh.amount')} value={schemeForm.amount} onChange={(e) => setSchemeForm({ ...schemeForm, amount: e.target.value })} className="input-field" />
                <input placeholder={t('agh.districts')} value={schemeForm.districts} onChange={(e) => setSchemeForm({ ...schemeForm, districts: e.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select value={schemeForm.status} onChange={(e) => setSchemeForm({ ...schemeForm, status: e.target.value })} className="input-field">
                  {STATUSES.map((s) => <option key={s} value={s}>{t(`agh.status.${s}`)}</option>)}
                </select>
                <input type="date" value={schemeForm.deadline} onChange={(e) => setSchemeForm({ ...schemeForm, deadline: e.target.value })} className="input-field" />
              </div>
              <input placeholder={t('agh.officialUrl')} value={schemeForm.official_url} onChange={(e) => setSchemeForm({ ...schemeForm, official_url: e.target.value })} className="input-field" dir="ltr" />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('agh.lastVerified')}</label>
                <input type="date" value={schemeForm.last_verified_at} onChange={(e) => setSchemeForm({ ...schemeForm, last_verified_at: e.target.value })} className="input-field" />
              </div>
              <button onClick={saveScheme} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editingScheme ? t('ic.updateBtn') : t('agh.addBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Disease guide form modal ── */}
      {showDiseaseForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowDiseaseForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingDisease ? t('agh.editDisease') : t('agh.addDisease')}</h2><button onClick={() => setShowDiseaseForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <input placeholder={t('agh.cropEn')} value={diseaseForm.crop} onChange={(e) => setDiseaseForm({ ...diseaseForm, crop: e.target.value })} className="input-field" />
                <input placeholder={t('agh.cropUr')} value={diseaseForm.crop_ur} onChange={(e) => setDiseaseForm({ ...diseaseForm, crop_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              </div>
              <input placeholder={t('agh.diseaseNameEn')} value={diseaseForm.disease_name} onChange={(e) => setDiseaseForm({ ...diseaseForm, disease_name: e.target.value })} className="input-field" />
              <input placeholder={t('agh.diseaseNameUr')} value={diseaseForm.disease_name_ur} onChange={(e) => setDiseaseForm({ ...diseaseForm, disease_name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.symptomsEn')} value={diseaseForm.symptoms} onChange={(e) => setDiseaseForm({ ...diseaseForm, symptoms: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.symptomsUr')} value={diseaseForm.symptoms_ur} onChange={(e) => setDiseaseForm({ ...diseaseForm, symptoms_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.sprayTimingEn')} value={diseaseForm.spray_timing} onChange={(e) => setDiseaseForm({ ...diseaseForm, spray_timing: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.sprayTimingUr')} value={diseaseForm.spray_timing_ur} onChange={(e) => setDiseaseForm({ ...diseaseForm, spray_timing_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.preventionEn')} value={diseaseForm.prevention} onChange={(e) => setDiseaseForm({ ...diseaseForm, prevention: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.preventionUr')} value={diseaseForm.prevention_ur} onChange={(e) => setDiseaseForm({ ...diseaseForm, prevention_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <button onClick={saveDisease} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editingDisease ? t('ic.updateBtn') : t('agh.addBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Help center form modal ── */}
      {showCenterForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowCenterForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingCenter ? t('agh.editCenter') : t('agh.addCenter')}</h2><button onClick={() => setShowCenterForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <select value={centerForm.category} onChange={(e) => setCenterForm({ ...centerForm, category: e.target.value })} className="input-field">
                {HELP_CENTER_CATEGORIES.map((c) => <option key={c} value={c}>{t(`agh.hcCat.${c}`)}</option>)}
              </select>
              <input placeholder={t('ve.titleEn')} value={centerForm.name} onChange={(e) => setCenterForm({ ...centerForm, name: e.target.value })} className="input-field" />
              <input placeholder={t('ve.titleUr')} value={centerForm.name_ur} onChange={(e) => setCenterForm({ ...centerForm, name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.whatTheyOfferEn')} value={centerForm.what_they_offer} onChange={(e) => setCenterForm({ ...centerForm, what_they_offer: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.whatTheyOfferUr')} value={centerForm.what_they_offer_ur} onChange={(e) => setCenterForm({ ...centerForm, what_they_offer_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <input placeholder={t('agh.phone')} value={centerForm.phone} onChange={(e) => setCenterForm({ ...centerForm, phone: e.target.value })} className="input-field" dir="ltr" />
              <input placeholder={t('agh.addressEn')} value={centerForm.address} onChange={(e) => setCenterForm({ ...centerForm, address: e.target.value })} className="input-field" />
              <input placeholder={t('agh.addressUr')} value={centerForm.address_ur} onChange={(e) => setCenterForm({ ...centerForm, address_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <button onClick={saveCenter} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editingCenter ? t('ic.updateBtn') : t('agh.addBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Livestock guide form modal ── */}
      {showLivestockForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowLivestockForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editingLivestock ? t('agh.editLivestock') : t('agh.addLivestock')}</h2><button onClick={() => setShowLivestockForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <input placeholder={t('agh.animalEn')} value={livestockForm.animal} onChange={(e) => setLivestockForm({ ...livestockForm, animal: e.target.value })} className="input-field" />
                <input placeholder={t('agh.animalUr')} value={livestockForm.animal_ur} onChange={(e) => setLivestockForm({ ...livestockForm, animal_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              </div>
              <input placeholder={t('agh.topicEn')} value={livestockForm.topic_name} onChange={(e) => setLivestockForm({ ...livestockForm, topic_name: e.target.value })} className="input-field" />
              <input placeholder={t('agh.topicUr')} value={livestockForm.topic_name_ur} onChange={(e) => setLivestockForm({ ...livestockForm, topic_name_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.detailsEn')} value={livestockForm.details} onChange={(e) => setLivestockForm({ ...livestockForm, details: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.detailsUr')} value={livestockForm.details_ur} onChange={(e) => setLivestockForm({ ...livestockForm, details_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.timingEn')} value={livestockForm.timing} onChange={(e) => setLivestockForm({ ...livestockForm, timing: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.timingUr')} value={livestockForm.timing_ur} onChange={(e) => setLivestockForm({ ...livestockForm, timing_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <textarea placeholder={t('agh.careTipsEn')} value={livestockForm.care_tips} onChange={(e) => setLivestockForm({ ...livestockForm, care_tips: e.target.value })} rows={2} className="input-field resize-none" />
              <textarea placeholder={t('agh.careTipsUr')} value={livestockForm.care_tips_ur} onChange={(e) => setLivestockForm({ ...livestockForm, care_tips_ur: e.target.value })} rows={2} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <button onClick={saveLivestock} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editingLivestock ? t('ic.updateBtn') : t('agh.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
