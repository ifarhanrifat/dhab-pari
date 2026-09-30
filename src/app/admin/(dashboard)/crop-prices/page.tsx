'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Wheat } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Price { id: string; commodity: string; commodity_ur: string | null; price: number; unit: string; category: string; display_order: number }
const UNITS = ['per_maund', 'per_kg', 'per_40kg', 'per_bag', 'other']
const CATEGORIES = ['crop', 'input', 'livestock_feed']
const empty = { commodity: '', commodity_ur: '', price: '', unit: 'per_maund', category: 'crop', display_order: 0 }

// Phase 3 of the "Village OS" feature set, 2026-10-01.
export default function AdminCropPricesPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<Price[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('crop_prices').select('*').order('category').order('display_order').order('commodity')
    setItems((data ?? []) as Price[]); setLoading(false)
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.commodity.trim() || !form.price) { toast.error(t('ag.fillRequired')); return }
    const { data: { user } } = await supabase.auth.getUser()
    const { data: me } = await supabase.from('admin_users').select('id').eq('auth_user_id', user!.id).single()
    const payload = {
      commodity: form.commodity.trim(), commodity_ur: form.commodity_ur.trim() || null,
      price: parseFloat(form.price), unit: form.unit, category: form.category, display_order: form.display_order,
      updated_at: new Date().toISOString(), updated_by: me?.id,
    }
    if (editing) {
      const { error } = await supabase.from('crop_prices').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ag.updated'))
    } else {
      const { error } = await supabase.from('crop_prices').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('ag.added'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const edit = (p: Price) => {
    setForm({ commodity: p.commodity, commodity_ur: p.commodity_ur ?? '', price: String(p.price), unit: p.unit, category: p.category, display_order: p.display_order })
    setEditing(p.id); setShowForm(true)
  }
  const remove = async (id: string) => { if (!confirm(t('ag.confirmDelete'))) return; await supabase.from('crop_prices').delete().eq('id', id); toast.success(t('ag.deleted')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2"><Wheat size={26} /> {t('ag.adminTitle')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('ag.add')}</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}
        {!loading && items.map((p) => (
          <div key={p.id} className="bg-white border border-dp-outline-variant rounded-lg p-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{t(`ag.cat.${p.category}`)}</span>
              <h3 className="font-sans text-[15px] font-bold text-dp-on-surface truncate mt-1">{p.commodity}{p.commodity_ur ? ` (${p.commodity_ur})` : ''}</h3>
              <p className="font-sans text-[13px] text-dp-on-surface-variant ltr-num">{p.price} {t(`ag.unit.${p.unit}`)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(p)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(p.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
        {!loading && items.length === 0 && <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('ag.empty')}</p>}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{editing ? t('ag.editTitle') : t('ag.addTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div>
                <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.category')}</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{t(`ag.cat.${c}`)}</option>)}
                </select>
              </div>
              <input placeholder={t('ag.commodityEn')} value={form.commodity} onChange={(e) => setForm({ ...form, commodity: e.target.value })} className="input-field" />
              <input placeholder={t('ag.commodityUr')} value={form.commodity_ur} onChange={(e) => setForm({ ...form, commodity_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu-ui)', direction: 'rtl' }} />
              <div className="grid grid-cols-2 gap-3">
                <input type="number" placeholder={t('ag.price')} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="input-field" />
                <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="input-field">
                  {UNITS.map((u) => <option key={u} value={u}>{t(`ag.unit.${u}`)}</option>)}
                </select>
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('ic.updateBtn') : t('ag.addBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
