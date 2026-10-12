'use client'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

// Phase 1 of the card-based redesign, 2026-10-12. The slide-up modal
// shell every quick action uses (water bill check, emergency numbers,
// chanda, zakat calculator, kafalat, blood request, complaint, login).
// Each caller supplies its own real content/logic -- this is only the
// shell (backdrop, slide-up animation, title bar, close), same as
// BottomSheet2 siblings Carousel2/Card2.
export function BottomSheet2({
  title, titleColor = '#005A36', onClose, children,
}: {
  title: string
  titleColor?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="absolute inset-0 z-50 bg-slate-900/60 backdrop-blur-[2px] flex items-end justify-center p-3 animate-in fade-in duration-200"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-h-[88%] overflow-y-auto bg-white rounded-[24px] p-4 animate-in slide-in-from-bottom-full duration-250">
        <div className="flex items-center justify-between pb-2 mb-3 border-b border-slate-200">
          <h3 className="text-[14px] font-bold" style={{ color: titleColor }}>{title}</h3>
          <button onClick={onClose} aria-label="close" className="text-slate-400 hover:text-slate-600 cursor-pointer">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
