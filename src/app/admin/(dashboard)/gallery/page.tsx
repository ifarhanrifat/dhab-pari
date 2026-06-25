'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PlusCircle, X, Trash2, Image as ImageIcon, ArrowLeft } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import { ImageUpload } from '@/components/admin/ImageUpload'

interface Album { id: string; title: string; title_ur: string | null; category: string | null; display_order: number }
interface Item { id: string; album_id: string; url: string; caption: string | null; display_order: number }
const albumCategories = ['projects', 'sports', 'kids', 'events', 'weddings', 'interviews']

export default function AdminGalleryPage() {
  const [albums, setAlbums] = useState<Album[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [showAlbumForm, setShowAlbumForm] = useState(false)
  const [showItemForm, setShowItemForm] = useState(false)
  const [albumForm, setAlbumForm] = useState({ title: '', title_ur: '', category: 'events' })
  const [itemForm, setItemForm] = useState({ url: '', caption: '' })
  const supabase = createClient()

  const loadAlbums = async () => { const { data } = await supabase.from('gallery_albums').select('*').order('display_order'); setAlbums(data ?? []); setLoading(false) }
  const loadItems = async (albumId: string) => { const { data } = await supabase.from('gallery_items').select('*').eq('album_id', albumId).order('display_order'); setItems(data ?? []) }
  useEffect(() => { loadAlbums() }, [])

  const openAlbum = (id: string) => { setSelectedAlbum(id); loadItems(id) }

  const saveAlbum = async () => {
    if (!albumForm.title.trim()) { toast.error('Title required'); return }
    const { error } = await supabase.from('gallery_albums').insert(albumForm)
    if (error) { toast.error(error.message); return }
    toast.success('Album created'); setShowAlbumForm(false); setAlbumForm({ title: '', title_ur: '', category: 'events' }); loadAlbums()
  }

  const deleteAlbum = async (id: string) => { if (!confirm('Delete album and all its items?')) return; await supabase.from('gallery_albums').delete().eq('id', id); toast.success('Deleted'); loadAlbums() }

  const addItem = async () => {
    if (!itemForm.url.trim() || !selectedAlbum) { toast.error('URL required'); return }
    const { error } = await supabase.from('gallery_items').insert({ album_id: selectedAlbum, url: itemForm.url, caption: itemForm.caption || null, display_order: items.length })
    if (error) { toast.error(error.message); return }
    toast.success('Item added'); setShowItemForm(false); setItemForm({ url: '', caption: '' }); loadItems(selectedAlbum)
  }

  const deleteItem = async (id: string) => { if (!selectedAlbum) return; await supabase.from('gallery_items').delete().eq('id', id); toast.success('Removed'); loadItems(selectedAlbum) }

  const selectedAlbumData = albums.find((a) => a.id === selectedAlbum)

  return (
    <>
      <Toaster position="top-right" />
      {!selectedAlbum ? (
        <>
          <div className="flex items-center justify-between mb-6">
            <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Gallery Albums</h1>
            <button onClick={() => setShowAlbumForm(true)} className="flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> New Album</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {loading && [1,2,3].map((i) => <div key={i} className="aspect-[4/3] bg-dp-surface-container rounded-lg animate-pulse" />)}
            {!loading && albums.map((a) => (
              <div key={a.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:border-dp-secondary transition-all group">
                <button onClick={() => openAlbum(a.id)} className="w-full aspect-[4/3] bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container flex items-center justify-center cursor-pointer">
                  <ImageIcon size={36} className="text-white/40" />
                </button>
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <h3 className="font-sans text-[16px] font-bold text-dp-on-surface">{a.title}</h3>
                    <span className="text-[12px] font-sans text-dp-on-surface-variant">{a.category}</span>
                  </div>
                  <button onClick={() => deleteAlbum(a.id)} className="p-1 text-dp-error hover:bg-dp-error/10 rounded cursor-pointer"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-4 mb-6">
            <button onClick={() => { setSelectedAlbum(null); setItems([]) }} className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline cursor-pointer"><ArrowLeft size={16} /> Albums</button>
            <h1 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">{selectedAlbumData?.title}</h1>
            <button onClick={() => setShowItemForm(true)} className="ml-auto flex items-center gap-2 px-4 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all"><PlusCircle size={16} /> Add Photo</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {items.map((item) => (
              <div key={item.id} className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden group relative">
                <div className="aspect-square bg-gradient-to-br from-dp-surface-container-high to-dp-surface-container flex items-center justify-center"><ImageIcon size={24} className="text-dp-on-surface-variant/30" /></div>
                {item.caption && <p className="p-2 text-[12px] font-sans text-dp-on-surface-variant">{item.caption}</p>}
                <button onClick={() => deleteItem(item.id)} className="absolute top-2 right-2 bg-black/50 text-white p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"><Trash2 size={14} /></button>
              </div>
            ))}
            {items.length === 0 && <div className="col-span-4 text-center py-12 text-dp-on-surface-variant font-sans">No items yet. Add photos above.</div>}
          </div>
        </>
      )}

      {showAlbumForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowAlbumForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">New Album</h2><button onClick={() => setShowAlbumForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Title</label><input value={albumForm.title} onChange={(e) => setAlbumForm({ ...albumForm, title: e.target.value })} className="input-field" /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Title (UR)</label><input value={albumForm.title_ur} onChange={(e) => setAlbumForm({ ...albumForm, title_ur: e.target.value })} className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} /></div>
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Category</label><select value={albumForm.category} onChange={(e) => setAlbumForm({ ...albumForm, category: e.target.value })} className="input-field">{albumCategories.map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
              <button onClick={saveAlbum} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Create Album</button>
            </div>
          </div>
        </div>
      )}

      {showItemForm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" onClick={() => setShowItemForm(false)}>
          <div className="bg-white rounded-lg p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6"><h2 className="font-heading text-[24px] font-bold text-dp-primary">Add Photo</h2><button onClick={() => setShowItemForm(false)} className="cursor-pointer"><X size={20} /></button></div>
            <div className="space-y-4">
              <ImageUpload bucket="images" currentUrl={itemForm.url} onUpload={(url) => setItemForm({ ...itemForm, url })} label="Photo" />
              <div><label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">Caption</label><input value={itemForm.caption} onChange={(e) => setItemForm({ ...itemForm, caption: e.target.value })} className="input-field" /></div>
              <button onClick={addItem} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">Add Photo</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
