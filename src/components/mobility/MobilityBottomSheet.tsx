'use client'

// Slide-up modal shell every booking form in the design uses (its own
// bottom-sheet pattern: tap outside or the drag handle to close). One
// shared shell so each booking screen only supplies its own content.

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export function MobilityBottomSheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  const { isUrdu } = useLocale()
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div dir={isUrdu ? 'rtl' : 'ltr'} className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl overflow-hidden max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="w-9 h-1 rounded-full bg-[#e2e8f0] mx-auto mt-2.5 sm:hidden" />
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          {title && <p className="font-sans text-[15px] font-bold text-[#1e293b]">{title}</p>}
          <button onClick={onClose} className="ms-auto cursor-pointer text-[#1e293b]"><X size={18} /></button>
        </div>
        <div className="px-4 pb-4">{children}</div>
      </div>
    </div>
  )
}
