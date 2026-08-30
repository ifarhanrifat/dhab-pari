'use client'

import Image from 'next/image'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'

interface LightboxImage { url: string; caption?: string }

/**
 * A minimal full-screen photo viewer — click a thumbnail, see it large,
 * step through the rest of the gallery without leaving the page. No
 * external library: this app has exactly one use for it (a project's
 * photo gallery), so a small self-contained component is less to carry
 * than a dependency for it.
 */
export function Lightbox({
  images, index, onClose, onNavigate,
}: {
  images: LightboxImage[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}) {
  if (index < 0 || index >= images.length) return null
  const img = images[index]

  return (
    <div className="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 end-4 text-white/90 hover:text-white p-2 cursor-pointer z-10" aria-label="Close">
        <X size={26} />
      </button>

      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate((index - 1 + images.length) % images.length) }}
          className="absolute start-2 sm:start-4 text-white/90 hover:text-white p-2 cursor-pointer z-10"
          aria-label="Previous"
        >
          <ChevronLeft size={30} />
        </button>
      )}

      <div className="relative max-w-[92vw] max-h-[82vh] w-full h-full" onClick={(e) => e.stopPropagation()}>
        <Image src={img.url} alt={img.caption ?? ''} fill sizes="92vw" className="object-contain" />
      </div>

      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); onNavigate((index + 1) % images.length) }}
          className="absolute end-2 sm:end-4 text-white/90 hover:text-white p-2 cursor-pointer z-10"
          aria-label="Next"
        >
          <ChevronRight size={30} />
        </button>
      )}

      <div className="absolute bottom-4 left-0 right-0 flex flex-col items-center gap-1.5">
        {img.caption && <p className="font-sans text-[13px] text-white/90 px-4 text-center">{img.caption}</p>}
        {images.length > 1 && <p className="font-sans text-[11px] text-white/60 ltr-num">{index + 1} / {images.length}</p>}
      </div>
    </div>
  )
}
