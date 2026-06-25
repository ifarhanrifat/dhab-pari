'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Trash2, ToggleLeft, ToggleRight } from 'lucide-react'
import { toast, Toaster } from 'sonner'

interface Ticker { id: string; message: string; message_ur: string | null; is_active: boolean; display_order: number }

export default function AdminTickerPage() {
  const [tickers, setTickers] = useState<Ticker[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ message: '', message_ur: '', display_order: 0 })
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('news_ticker').select('*').order('display_order'); setTickers(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.message.trim()) { toast.error('Message required'); return }
    const { error } = await supabase.from('news_ticker').insert({ message: form.message, message_ur: form.message_ur || null, is_active: true, display_order: form.display_order || tickers.length })
    if (error) { toast.error(error.message); return }
    toast.success('Added'); setShowForm(false); setForm({ message: '', message_ur: '', display_order: 0 }); load()
  }

  const toggleActive = async (id: string, current: boolean) => { await supabase.from('news_ticker').update({ is_active: !current }).eq('id', id); load() }
  const remove = async (id: string) => { if (!confirm('Delete?')) return; await supabase.from('news_ticker').delete().eq('id', id); toast.success('Deleted'); load() }

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Ticker Messages</h1>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Message</button>
      </div>
      <div className="space-y-3">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant">Loading...</div>}
        {!loading && tickers.map((t) => (
          <div key={t.id} className={`bg-white border rounded-lg p-4 flex items-start gap-4 transition-all ${t.is_active ? 'border-dp-outline-variant' : 'border-dp-outline-variant/50 opacity-50'}`}>
            <button onClick={() => toggleActive(t.id, t.is_active)} className="shrink-0 mt-1 cursor-pointer">
              {t.is_active ? <ToggleRight size={24} className="text-dp-secondary" /> : <ToggleLeft size={24} className="text-dp-on-surface-variant" />}
            </button>
            <div className="flex-1 min-w-0">
              <p className="font-sans text-[16px] text-dp-on-surface">{t.message}</p>
              {t.message_ur && <p className="text-[14px] text-dp-on-surface-variant mt-1" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl', lineHeight: '2' }}>{t.message_ur}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[12px] font-sans text-dp-on-surface-variant">#{t.display_order}</span>
              <button onClick={() => remove(t.id)} className="p-1 text-dp-error hover:bg-dp-error/10 rounded cursor-pointer"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">Add Ticker Message</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Message (EN)</label><textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={3} className="input-field resize-none" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Message (UR)</label><textarea value={form.message_ur} onChange={(e) => setForm({ ...form, message_ur: e.target.value })} rows={3} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Display Order</label><input type="number" value={form.display_order} onChange={(e) => setForm({ ...form, display_order: +e.target.value })} className="input-field" /></div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Add Message</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
