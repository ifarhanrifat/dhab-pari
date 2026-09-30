'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Phone } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Contact {
  id: string; label: string; label_ur: string | null; phone: string; whatsapp_number: string | null
  category: string; display_order: number; is_active: boolean
}
const categories = ['police', 'rescue', 'fire', 'ambulance', 'hospital', 'electricity', 'gas', 'water', 'union_council', 'village_rep', 'other']
const empty = { label: '', label_ur: '', phone: '', whatsapp_number: '', category: 'other', display_order: 0, is_active: true }

export default function AdminImportantContactsPage() {
  const { t, isUrdu } = useLocale()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('important_contacts').select('*').order('display_order').order('created_at')
    setContacts(data ?? []); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.label.trim() || !form.phone.trim()) { toast.error(t('ic.labelPhoneRequired')); return }
    if (editing) { const { error } = await supabase.from('important_contacts').update(form).eq('id', editing); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('ic.updated')) }
    else { const { error } = await supabase.from('important_contacts').insert(form); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('ic.added')) }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }
  const edit = (c: Contact) => {
    setForm({ label: c.label, label_ur: c.label_ur ?? '', phone: c.phone, whatsapp_number: c.whatsapp_number ?? '', category: c.category, display_order: c.display_order, is_active: c.is_active })
    setEditing(c.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('ic.confirmDelete'))) return; await supabase.from('important_contacts').delete().eq('id', id); toast.success(t('ic.deleted')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('ic.title')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('ic.add')}</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && contacts.map((c) => (
          <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4 hover:border-dp-secondary transition-all">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container flex items-center justify-center shrink-0"><Phone size={16} /></span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate">{c.label}</h3>
                  <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans shrink-0">{t(`ic.cat.${c.category}`)}</span>
                  {!c.is_active && <span className="text-[10px] font-bold font-sans text-dp-on-surface-variant shrink-0">{t('ic.inactive')}</span>}
                </div>
                <p className="font-sans text-[13px] text-dp-on-surface-variant ltr-num">{c.phone}{c.whatsapp_number ? ` · WA ${c.whatsapp_number}` : ''}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(c)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(c.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && contacts.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('ic.empty')}</p>}
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('ic.editTitle') : t('ic.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.labelEn')}</label><input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="input-field" placeholder="Police" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.labelUr')}</label><input value={form.label_ur} onChange={(e) => setForm({ ...form, label_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} placeholder="پولیس" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.phone')}</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="input-field" placeholder="15" /></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.whatsapp')}</label><input value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} className="input-field" placeholder="0300-0000000" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.category')}</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">{categories.map((c) => <option key={c} value={c}>{t(`ic.cat.${c}`)}</option>)}</select></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('ic.order')}</label><input type="number" value={form.display_order} onChange={(e) => setForm({ ...form, display_order: +e.target.value })} className="input-field" /></div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('ic.active')}</span></label>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('ic.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
