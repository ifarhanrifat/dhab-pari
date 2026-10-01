'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Landmark, UserCheck, UserX, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'
import { PortalUserSearchPicker, type PortalUserLite } from '@/components/admin/PortalUserSearchPicker'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface DirEntry { id: string; name: string }
interface Campaign {
  id: string; type: string; directory_entry_id: string | null; title: string; title_ur: string | null
  description: string | null; description_ur: string | null; target_amount: number | null
  payment_method: string; account_number: string; account_title: string | null; bank_name: string | null
  cover_image_url: string | null
  display_until: string; is_active: boolean; manager_portal_user_id: string | null; manager?: PortalUserLite
}

const TYPES = ['mosque', 'janaza_gah']
const DURATIONS = [1, 2, 3, 4, 5, 6]
const empty = {
  type: 'mosque', directory_entry_id: '', title: '', title_ur: '', description: '', description_ur: '',
  target_amount: '', payment_method: 'easypaisa', account_number: '', account_title: '', bank_name: '',
  cover_image_url: '', duration_months: '3', is_active: true,
}

// Phase 3 of the "Village OS" feature set, 2026-10-01. Chanda (Mosque /
// Janaza Gah fund collection) -- a standing campaign, not a dated event,
// so it's its own admin page rather than living under Events.
//
// Real security correction, 2026-10-01: "this link part is unsecure what
// if it get leaked" -- the manage_token copy-link is gone from this UI;
// a campaign is managed by linking it to a real portal account instead
// (migration 554), the same fix applied to wedding Salami.
export default function AdminChandaPage() {
  const { t, isUrdu } = useLocale()
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [mosques, setMosques] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [managingId, setManagingId] = useState<string | null>(null)
  const supabase = createClient()

  const load = async () => {
    const [{ data: c }, { data: m }] = await Promise.all([
      supabase.from('chanda_campaigns').select('*').order('created_at', { ascending: false }),
      supabase.from('directory_entries').select('id, name').eq('category', 'mosque').eq('is_active', true).order('name'),
    ])
    const rows = (c ?? []) as Campaign[]
    const managerIds = rows.map((r) => r.manager_portal_user_id).filter((id): id is string => !!id)
    if (managerIds.length > 0) {
      const { data: managers } = await supabase.from('portal_users').select('id, full_name, mobile').in('id', managerIds)
      rows.forEach((r) => { r.manager = managers?.find((mg) => mg.id === r.manager_portal_user_id) })
    }
    setCampaigns(rows); setMosques((m ?? []) as DirEntry[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    const cost = parseFloat(form.target_amount)
    if (!form.title.trim() || !form.account_number.trim() || !form.description.trim() || !cost || cost <= 0) {
      toast.error(t('ch.fillRequired')); return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const payload = {
      type: form.type, directory_entry_id: form.type === 'mosque' ? (form.directory_entry_id || null) : null,
      title: form.title.trim(), title_ur: form.title_ur.trim() || null,
      description: form.description.trim() || null, description_ur: form.description_ur.trim() || null,
      target_amount: form.target_amount ? parseFloat(form.target_amount) : null,
      payment_method: form.payment_method, account_number: form.account_number.trim(),
      account_title: form.account_title.trim() || null, bank_name: form.bank_name.trim() || null,
      cover_image_url: form.cover_image_url || null,
      is_active: form.is_active,
      display_until: new Date(Date.now() + parseInt(form.duration_months, 10) * 30 * 86400000).toISOString(),
      created_by: me?.id,
    }
    if (editing) {
      const { error } = await supabase.from('chanda_campaigns').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ch.updated'))
    } else {
      const { error } = await supabase.from('chanda_campaigns').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ch.added'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const edit = (c: Campaign) => {
    const monthsLeft = Math.max(1, Math.min(6, Math.round((new Date(c.display_until).getTime() - Date.now()) / (30 * 86400000))))
    setForm({
      type: c.type, directory_entry_id: c.directory_entry_id ?? '', title: c.title, title_ur: c.title_ur ?? '',
      description: c.description ?? '', description_ur: c.description_ur ?? '', target_amount: c.target_amount != null ? String(c.target_amount) : '',
      payment_method: c.payment_method, account_number: c.account_number, account_title: c.account_title ?? '', bank_name: c.bank_name ?? '',
      cover_image_url: c.cover_image_url ?? '', duration_months: String(monthsLeft), is_active: c.is_active,
    })
    setEditing(c.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('ch.confirmDelete'))) return; await supabase.from('chanda_campaigns').delete().eq('id', id); toast.success(t('ch.deleted')); load() }

  const linkManager = async (campaignId: string, user: PortalUserLite) => {
    const { error } = await supabase.from('chanda_campaigns').update({ manager_portal_user_id: user.id }).eq('id', campaignId)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('fnd.managerLinked'))
    setManagingId(null); load()
  }
  const unlinkManager = async (campaignId: string) => {
    const { error } = await supabase.from('chanda_campaigns').update({ manager_portal_user_id: null }).eq('id', campaignId)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('fnd.managerUnlinked'))
    load()
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Landmark size={26} /> {t('ch.adminTitle')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('ch.add')}</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && campaigns.map((c) => (
          <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                {c.cover_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.cover_image_url} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0 border border-dp-outline-variant" />
                )}
                <div className="min-w-0">
                  <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`ch.type.${c.type}`)}</span>
                  {new Date(c.display_until) < new Date() && <span className="text-[10px] font-bold font-sans text-dp-error ms-1.5">{t('ch.expired')}</span>}
                  <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{c.title}</h3>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant">{t('ch.displayUntil')}: <span className="ltr-num">{new Date(c.display_until).toLocaleDateString()}</span></p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => edit(c)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
                <button onClick={() => remove(c.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
              </div>
            </div>
            {/* Real security correction, 2026-10-01: "this link part is
                unsecure" -- a linked portal account replaces the
                manage_token copy-link entirely. */}
            <div className="mt-3 pt-3 border-t border-dp-outline-variant">
              {c.manager ? (
                <div className="flex items-center justify-between gap-2 bg-emerald-50 rounded-lg p-2.5">
                  <span className="flex items-center gap-1.5 font-sans text-[12.5px] text-emerald-800"><UserCheck size={14} /> {t('fnd.managedBy')}: {c.manager.full_name} · <span className="ltr-num">{c.manager.mobile}</span></span>
                  <button onClick={() => unlinkManager(c.id)} title={t('fnd.unlink')} className="p-1 text-emerald-700 hover:bg-emerald-100 rounded cursor-pointer"><UserX size={14} /></button>
                </div>
              ) : managingId === c.id ? (
                <PortalUserSearchPicker onPick={(u) => linkManager(c.id, u)} />
              ) : (
                <button onClick={() => setManagingId(c.id)} className="flex items-center gap-1.5 font-sans text-[12.5px] font-semibold text-dp-secondary cursor-pointer hover:underline">
                  <UserPlus size={14} /> {t('fnd.linkManager')}
                </button>
              )}
            </div>
          </div>
        ))}
        {!loading && campaigns.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('ch.empty')}</p>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editing ? t('ch.editTitle') : t('ch.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="input-field">
                  {TYPES.map((ty) => <option key={ty} value={ty}>{t(`ch.type.${ty}`)}</option>)}
                </select>
              </div>
              {form.type === 'mosque' && (
                <div>
                  <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ch.linkedMosque')}</label>
                  <select value={form.directory_entry_id} onChange={(e) => setForm({ ...form, directory_entry_id: e.target.value })} className="input-field">
                    <option value="">—</option>
                    {mosques.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}
              <input placeholder={t('ve.titleEn')} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" />
              <input placeholder={t('ve.titleUr')} value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <ImageUpload bucket="images" currentUrl={form.cover_image_url} onUpload={(url) => setForm({ ...form, cover_image_url: url })} label={t('ch.coverImage')} />
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ch.workDescription')} *</label>
                <textarea placeholder={t('ch.workDescription')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="input-field resize-none" />
                <p className="font-sans text-[11.5px] text-dp-on-surface-variant mt-1">{t('ch.workDescriptionHint')}</p>
              </div>
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ch.targetAmount')} *</label>
                <input type="number" placeholder={t('ch.targetAmount')} value={form.target_amount} onChange={(e) => setForm({ ...form, target_amount: e.target.value })} className="input-field" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <select value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} className="input-field">
                  <option value="easypaisa">Easypaisa</option>
                  <option value="jazzcash">JazzCash</option>
                  <option value="bank">{t('sl.bank')}</option>
                </select>
                <input placeholder={t('sl.accountNumber')} value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} className="input-field" />
              </div>
              <input placeholder={t('sl.accountTitle')} value={form.account_title} onChange={(e) => setForm({ ...form, account_title: e.target.value })} className="input-field" />
              {form.payment_method === 'bank' && <input placeholder={t('sl.bankName')} value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} className="input-field" />}
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('ch.duration')}</label>
                <select value={form.duration_months} onChange={(e) => setForm({ ...form, duration_months: e.target.value })} className="input-field">
                  {DURATIONS.map((d) => <option key={d} value={d}>{d} {t('ch.months')}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('ic.active')}</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('ch.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
