'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Star } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { VideoUpload } from '@/components/admin/VideoUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Video { id: string; title: string; title_ur: string | null; description: string | null; video_url: string; thumbnail_url: string | null; category: string | null; duration_seconds: number | null; is_published: boolean; is_featured: boolean; views: number }
const categories = ['wedding', 'interview', 'event', 'sports', 'news', 'documentary', 'project']
const empty = { title: '', title_ur: '', description: '', video_url: '', thumbnail_url: '', category: 'event', duration_seconds: 0, is_published: false, is_featured: false }

export default function AdminVideosPage() {
  const { t, isUrdu } = useLocale()
  const [videos, setVideos] = useState<Video[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const supabase = createClient()

  const load = async () => { const { data } = await supabase.from('video_content').select('*').order('created_at', { ascending: false }); setVideos(data ?? []); setLoading(false) }
  useEffect(() => { load() }, [])

  const save = async () => {
    if (!form.title.trim() || !form.video_url.trim()) { toast.error(t('vd.titleUrlRequired')); return }
    const payload = { ...form, duration_seconds: form.duration_seconds || null }
    if (editing) { const { error } = await supabase.from('video_content').update(payload).eq('id', editing); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('vd.updated')) }
    else { const { error } = await supabase.from('video_content').insert(payload); if (error) { toast.error(friendlyError(error)); return }; toast.success(t('vd.added')) }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }
  const edit = (v: Video) => { setForm({ title: v.title, title_ur: v.title_ur ?? '', description: v.description ?? '', video_url: v.video_url, thumbnail_url: v.thumbnail_url ?? '', category: v.category ?? 'event', duration_seconds: v.duration_seconds ?? 0, is_published: v.is_published, is_featured: v.is_featured }); setEditing(v.id); setShowForm(true) }
  const remove = async (id: string) => { if (!confirm(t('vd.confirmDelete'))) return; await supabase.from('video_content').delete().eq('id', id); toast.success(t('vd.deleted')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t('y.videos')}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t('y.addVideo')}</button>
      </div>
      <div className="space-y-4">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
        {!loading && videos.map((v) => (
          <div key={v.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 flex items-center justify-between gap-4 hover:border-dp-secondary transition-all">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{v.category}</span>
                {v.is_featured && <Star size={12} className="text-amber-500 fill-amber-500" />}
                <span className={`text-[10px] font-bold font-sans ${v.is_published ? 'text-dp-secondary' : 'text-dp-on-surface-variant'}`}>{v.is_published ? t('g.published') : t('y.draft')}</span>
              </div>
              <h3 className="font-sans text-[16px] font-bold text-dp-on-surface truncate">{v.title}</h3>
              <p className="font-sans text-[12px] text-dp-on-surface-variant">{v.views} {t('vd.viewsSuffix')} · {v.duration_seconds ? `${Math.floor(v.duration_seconds / 60)}m` : '—'}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => edit(v)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(v.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>
      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('vd.editVideoTitle') : t('vd.addVideoTitle')}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.titleEn')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.titleUr')}</label><input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <VideoUpload currentUrl={form.video_url} onUpload={(url) => setForm({ ...form, video_url: url })} />
              <ImageUpload bucket="thumbnails" currentUrl={form.thumbnail_url} onUpload={(url) => setForm({ ...form, thumbnail_url: url })} label={t('vd.thumbnailImage')} />
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">{categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('y.durationSec')}</label><input type="number" value={form.duration_seconds || ''} onChange={(e) => setForm({ ...form, duration_seconds: +e.target.value })} className="input-field" /></div>
              </div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.description')}</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="input-field resize-none" /></div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('g.published')}</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_featured} onChange={(e) => setForm({ ...form, is_featured: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('y.featured')}</span></label>
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('vd.updateVideoBtn') : t('vd.addVideoBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
