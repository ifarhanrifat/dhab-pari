'use client'

// Shared by /admin/news, /admin/poetry and /admin/blog — all three write the
// same news_posts table (migration 181: "Editorial and Poetry are articles",
// migration 303 folds Blog into that same idea) and only really differ in
// which category they're scoped to and who may write it. RLS is what
// actually enforces that scoping (current_admin_can_publish_category(),
// migration 303) — fixedCategory/excludeCategoryKeys here are just the UI
// staying out of the way of a form nobody could successfully submit anyway.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Pencil, Trash2, Eye, EyeOff, Star } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { BulkActionsBar } from '@/components/admin/BulkActionsBar'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Post { id: string; title: string; title_ur: string | null; content: string; content_ur: string | null; category: string | null; cover_image_url: string | null; author: string; is_published: boolean; is_featured: boolean; views: number; published_at: string | null }
interface PostCategory { key: string; label_en: string; label_ur: string; icon: string | null }

interface PostsManagerProps {
  titleKey: string
  newPostKey: string
  /** Fixed for /admin/poetry and /admin/blog — the category field never shows. */
  fixedCategory?: string
  /** Hidden from the picker on /admin/news — Poetry/Blog have their own pages/permission now. */
  excludeCategoryKeys?: string[]
}

export function PostsManager({ titleKey, newPostKey, fixedCategory, excludeCategoryKeys = [] }: PostsManagerProps) {
  const { t, isUrdu } = useLocale()
  const empty = { title: '', title_ur: '', content: '', content_ur: '', category: fixedCategory ?? 'announcement', author: 'Committee', is_published: false, is_featured: false, cover_image_url: '' }
  const [posts, setPosts] = useState<Post[]>([])
  const [categories, setCategories] = useState<PostCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(empty)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const [{ data }, { data: cats }] = await Promise.all([
      fixedCategory
        ? supabase.from('news_posts').select('*').eq('category', fixedCategory).order('created_at', { ascending: false })
        : supabase.from('news_posts').select('*').order('created_at', { ascending: false }),
      supabase.from('post_categories').select('key, label_en, label_ur, icon').eq('is_active', true).order('display_order'),
    ])
    // A News-scoped page still only shows News rows even if a stray row from
    // before Poetry/Blog had their own pages carries one of those categories.
    setPosts(fixedCategory ? (data ?? []) : (data ?? []).filter((p) => !excludeCategoryKeys.includes(p.category ?? '')))
    setCategories((cats ?? []).filter((c) => !excludeCategoryKeys.includes(c.key)))
    setLoading(false)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === posts.length) setSelected(new Set())
    else setSelected(new Set(posts.map((p) => p.id)))
  }

  const bulkPublish = async (publish: boolean) => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('news_posts').update({ is_published: publish, published_at: publish ? new Date().toISOString() : null }).in('id', ids)
    if (error) { toast.error(t('nw.failedUpdate')); return }
    toast.success(`${ids.length} ${publish ? t('nw.published') : t('nw.unpublished')}`)
    setSelected(new Set())
    load()
  }

  const bulkDelete = async () => {
    const ids = Array.from(selected)
    const { error } = await supabase.from('news_posts').delete().in('id', ids)
    if (error) { toast.error(t('nw.failedDelete')); return }
    toast.success(`${ids.length} ${t('nw.postsDeletedSuffix')}`)
    setSelected(new Set())
    setConfirmDelete(false)
    load()
  }

  // Poetry is Urdu-only (no English version at all) — the Urdu fields are
  // what's required and shown; on save they're mirrored into the plain
  // title/content columns too (still NOT NULL in the schema, shared with
  // News/Blog) so every other place that reads .title/.content raw — the
  // public listing, the detail page, RSS if it's ever added — just works
  // without needing its own poetry-aware branch.
  const isPoetry = fixedCategory === 'poetry'

  const save = async () => {
    if (isPoetry) {
      if (!form.title_ur.trim() || !form.content_ur.trim()) { toast.error(t('nw.titleContentRequired')); return }
    } else if (!form.title.trim() || !form.content.trim()) { toast.error(t('nw.titleContentRequired')); return }
    const payload = {
      ...form,
      ...(isPoetry ? { title: form.title_ur, content: form.content_ur } : {}),
      published_at: form.is_published ? new Date().toISOString() : null,
    }
    if (editing) {
      const { error } = await supabase.from('news_posts').update(payload).eq('id', editing)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('nw.postUpdated'))
    } else {
      const { error } = await supabase.from('news_posts').insert(payload)
      if (error) { toast.error(friendlyError(error)); return }
      toast.success(t('nw.postCreated'))
    }
    setShowForm(false); setEditing(null); setForm(empty); load()
  }

  const togglePublish = async (id: string, current: boolean) => {
    await supabase.from('news_posts').update({ is_published: !current, published_at: !current ? new Date().toISOString() : null }).eq('id', id)
    toast.success(current ? t('nw.unpublished') : t('nw.published'))
    load()
  }

  const edit = (p: Post) => { setForm({ title: p.title, title_ur: p.title_ur ?? '', content: p.content, content_ur: p.content_ur ?? '', category: p.category ?? (fixedCategory ?? 'announcement'), author: p.author, is_published: p.is_published, is_featured: p.is_featured, cover_image_url: p.cover_image_url ?? '' }); setEditing(p.id); setShowForm(true) }
  const remove = async (id: string) => { if (!confirm(t('nw.confirmDeletePost'))) return; await supabase.from('news_posts').delete().eq('id', id); toast.success(t('nw.deletedToast')); load() }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">{t(titleKey)}</h1>
        <button onClick={() => { setForm(empty); setEditing(null); setShowForm(true) }} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> {t(newPostKey)}</button>
      </div>

      <BulkActionsBar
        count={selected.size}
        onClear={() => setSelected(new Set())}
        actions={[
          { label: t('nw.publishSelected'), onClick: () => bulkPublish(true), variant: 'primary' },
          { label: t('nw.unpublishSelected'), onClick: () => bulkPublish(false), variant: 'outline' },
          { label: t('nw.deleteSelected'), onClick: () => setConfirmDelete(true), variant: 'danger' },
        ]}
      />

      {!loading && posts.length > 0 && (
        <label className="flex items-center gap-2 mb-3 cursor-pointer w-fit">
          <input type="checkbox" checked={selected.size === posts.length} onChange={toggleSelectAll} className="accent-dp-secondary cursor-pointer" />
          <span className="font-sans text-[14px] text-dp-on-surface-variant">{t('g.selectAll')}</span>
        </label>
      )}

      <div className="space-y-4">
        {loading && <div className="text-center py-12 text-dp-on-surface-variant">{t('action.loading')}</div>}
        {!loading && posts.map((p) => (
          <div key={p.id} className={`bg-white border rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-dp-secondary transition-all ${selected.has(p.id) ? 'border-dp-secondary bg-dp-secondary-container/10' : 'border-dp-outline-variant'}`}>
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} className="accent-dp-secondary cursor-pointer mt-1.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  {!fixedCategory && <span className="bg-dp-surface-container-high px-2 py-0.5 rounded text-[10px] font-bold uppercase font-sans">{p.category}</span>}
                  {p.is_published ? <span className="text-dp-secondary text-[10px] font-bold font-sans flex items-center gap-1"><Eye size={12} />{t('g.published')}</span> : <span className="text-dp-on-surface-variant text-[10px] font-bold font-sans flex items-center gap-1"><EyeOff size={12} />{t('y.draft')}</span>}
                  {p.is_featured && <span className="text-amber-600 text-[10px] font-bold font-sans flex items-center gap-1"><Star size={12} fill="currentColor" />{t('y.featured')}</span>}
                </div>
                <h3 className="font-sans text-[18px] font-bold text-dp-on-surface truncate">{p.title}</h3>
                <p className="font-sans text-[14px] text-dp-on-surface-variant truncate">{p.content.slice(0, 80)}...</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => togglePublish(p.id, p.is_published)} className={`px-3 py-1 rounded text-[14px] font-sans font-semibold cursor-pointer transition-all ${p.is_published ? 'border border-dp-outline-variant text-dp-on-surface-variant hover:bg-dp-surface-container' : 'bg-dp-secondary text-white hover:bg-dp-primary'}`}>{p.is_published ? t('nw.unpublishBtn') : t('nw.publishBtn')}</button>
              <button onClick={() => edit(p)} className="p-2 text-dp-primary hover:bg-dp-primary/10 rounded-lg cursor-pointer"><Pencil size={16} /></button>
              <button onClick={() => remove(p.id)} className="p-2 text-dp-error hover:bg-dp-error/10 rounded-lg cursor-pointer"><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t('nw.deletePostsTitle')}
        message={t('nw.deletePostsMessage').replace('{n}', String(selected.size))}
        onConfirm={bulkDelete}
        onCancel={() => setConfirmDelete(false)}
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">{editing ? t('nw.editPostTitle') : t(newPostKey)}</h2><button onClick={() => setShowForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              {!isPoetry && (
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.titleEn')}</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="input-field" /></div>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{isPoetry ? t('y.poemTitle') : t('a.titleUr')}</label><input value={form.title_ur} onChange={(e) => setForm({ ...form, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              {!isPoetry && (
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('y.contentEn')}</label><textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={6} className="input-field resize-none" /></div>
              )}
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{isPoetry ? t('y.poemContent') : t('y.contentUr')}</label><textarea value={form.content_ur} onChange={(e) => setForm({ ...form, content_ur: e.target.value })} rows={4} className="input-field resize-none" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <ImageUpload bucket="images" currentUrl={form.cover_image_url} onUpload={(url) => setForm({ ...form, cover_image_url: url })} label={t('nw.coverImage')} />
              <div className="grid grid-cols-2 gap-4">
                {!fixedCategory && (
                  <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.category')}</label><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="input-field">{categories.map((c) => <option key={c.key} value={c.key}>{c.icon ? `${c.icon} ` : ''}{c.label_en} — {c.label_ur}</option>)}</select></div>
                )}
                <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('y.author')}</label><input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} className="input-field" /></div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={form.is_published} onChange={(e) => setForm({ ...form, is_published: e.target.checked })} className="accent-dp-secondary" /><span className="font-sans text-[14px]">{t('y.publishNow')}</span></label>
                <label className="flex items-center gap-2 cursor-pointer" title={t('y.featuredHint')}><input type="checkbox" checked={form.is_featured} onChange={(e) => setForm({ ...form, is_featured: e.target.checked })} className="accent-amber-500" /><span className="font-sans text-[14px] flex items-center gap-1"><Star size={14} className="text-amber-600" />{t('y.featured')}</span></label>
              </div>
              <button onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">{editing ? t('nw.updatePostBtn') : t('nw.createPostBtn')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
