'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { X, Image as ImageIcon, ChevronLeft, ChevronRight } from 'lucide-react'

interface Album {
  id: string
  title: string
  title_ur: string | null
  category: string | null
  cover_url: string | null
}

interface GalleryItem {
  id: string
  album_id: string
  url: string
  caption: string | null
  type: string
  display_order: number
}

const categoryColors: Record<string, string> = {
  projects: 'from-dp-primary-container to-dp-tertiary-container',
  sports: 'from-emerald-600 to-emerald-800',
  kids: 'from-blue-500 to-blue-700',
  events: 'from-indigo-500 to-indigo-700',
  weddings: 'from-pink-500 to-pink-700',
  interviews: 'from-amber-500 to-amber-700',
}

export default function GalleryPage() {
  const [albums, setAlbums] = useState<Album[]>([])
  const [items, setItems] = useState<GalleryItem[]>([])
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('gallery_albums')
      .select('*')
      .order('display_order')
      .then(({ data }) => {
        setAlbums(data ?? [])
        setLoading(false)
      })
  }, [])

  const loadAlbumItems = async (albumId: string) => {
    setSelectedAlbum(albumId)
    const supabase = createClient()
    const { data } = await supabase
      .from('gallery_items')
      .select('*')
      .eq('album_id', albumId)
      .order('display_order')
    setItems(data ?? [])
  }

  const closeAlbum = () => {
    setSelectedAlbum(null)
    setItems([])
    setLightboxIndex(null)
  }

  const selectedAlbumData = albums.find((a) => a.id === selectedAlbum)
  const albumItems = items

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-10">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">
          Photo & Video Gallery
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px] mt-2">
          Browse through moments captured from village events, projects, and celebrations.
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="aspect-[4/3] bg-dp-surface-container rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {/* Albums Grid (when no album selected) */}
      {!loading && !selectedAlbum && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {albums.map((album) => {
            const gradient = categoryColors[album.category ?? ''] ?? 'from-dp-primary to-dp-primary-container'
            return (
              <button
                key={album.id}
                onClick={() => loadAlbumItems(album.id)}
                className="relative aspect-[4/3] rounded-lg overflow-hidden group cursor-pointer text-left"
              >
                <div className={`absolute inset-0 bg-gradient-to-br ${gradient} group-hover:scale-105 transition-transform duration-500`} />
                <div className="absolute inset-0 bg-black/20 group-hover:bg-black/30 transition-colors" />
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-4">
                  <ImageIcon size={36} className="mb-3 opacity-80" />
                  <h3 className="font-heading text-[20px] font-bold text-center leading-[28px]">
                    {album.title}
                  </h3>
                  {album.category && (
                    <span className="mt-2 text-[12px] font-sans font-semibold tracking-[0.05em] uppercase bg-white/20 px-3 py-1 rounded-full">
                      {album.category}
                    </span>
                  )}
                </div>
              </button>
            )
          })}
          {albums.length === 0 && !loading && (
            <div className="col-span-3 text-center py-16 text-dp-on-surface-variant font-sans">
              No albums yet.
            </div>
          )}
        </div>
      )}

      {/* Album Items View */}
      {selectedAlbum && selectedAlbumData && (
        <div>
          {/* Back header */}
          <div className="flex items-center gap-4 mb-8">
            <button
              onClick={closeAlbum}
              className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline cursor-pointer"
            >
              <ChevronLeft size={16} />
              Back to Albums
            </button>
            <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary">
              {selectedAlbumData.title}
            </h2>
          </div>

          {/* Masonry-style grid */}
          <div className="columns-2 md:columns-3 gap-4 space-y-4">
            {albumItems.map((item, i) => (
              <button
                key={item.id}
                onClick={() => setLightboxIndex(i)}
                className="block w-full rounded-lg overflow-hidden bg-dp-surface-container hover:opacity-90 transition-opacity cursor-pointer break-inside-avoid"
              >
                <div className={`w-full bg-gradient-to-br from-dp-primary-container to-dp-surface-container-high flex items-center justify-center ${i % 3 === 0 ? 'h-48' : i % 3 === 1 ? 'h-36' : 'h-56'}`}>
                  <ImageIcon size={24} className="text-dp-on-primary-container/30" />
                </div>
                {item.caption && (
                  <p className="p-3 text-[14px] font-sans text-dp-on-surface-variant text-left">
                    {item.caption}
                  </p>
                )}
              </button>
            ))}
          </div>

          {albumItems.length === 0 && (
            <div className="text-center py-16 text-dp-on-surface-variant font-sans">
              No items in this album yet.
            </div>
          )}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIndex !== null && albumItems[lightboxIndex] && (
        <div className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center">
          <button
            onClick={() => setLightboxIndex(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white cursor-pointer z-[110]"
          >
            <X size={32} />
          </button>

          {lightboxIndex > 0 && (
            <button
              onClick={() => setLightboxIndex(lightboxIndex - 1)}
              className="absolute left-4 text-white/80 hover:text-white cursor-pointer"
            >
              <ChevronLeft size={40} />
            </button>
          )}

          {lightboxIndex < albumItems.length - 1 && (
            <button
              onClick={() => setLightboxIndex(lightboxIndex + 1)}
              className="absolute right-4 text-white/80 hover:text-white cursor-pointer"
            >
              <ChevronRight size={40} />
            </button>
          )}

          <div className="max-w-4xl max-h-[80vh] flex flex-col items-center">
            <div className="w-full max-h-[70vh] bg-gradient-to-br from-dp-primary-container to-dp-surface-container-high rounded-lg flex items-center justify-center min-h-[300px] min-w-[400px]">
              <ImageIcon size={48} className="text-white/30" />
            </div>
            {albumItems[lightboxIndex].caption && (
              <p className="text-white/80 font-sans text-[16px] mt-4 text-center">
                {albumItems[lightboxIndex].caption}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
