'use client'

import { Menu } from 'lucide-react'
import { SITE } from '@/lib/constants'

interface AdminHeaderProps {
  onMenuToggle?: () => void
}

export function AdminHeader({ onMenuToggle }: AdminHeaderProps) {
  return (
    // Menu button on the LEFT, matching the public header and the sidebar
    // that slides in from the left. It used to sit on the far right, so the
    // panel appeared to come from the opposite side of the tap.
    <header className="md:hidden bg-dp-primary px-4 py-4 flex items-center gap-2.5 sticky top-0 z-50">
      <button
        onClick={onMenuToggle}
        className="text-white p-1.5 -ms-1.5 shrink-0"
        aria-label="Toggle menu"
      >
        <Menu size={26} />
      </button>
      <h1 className="text-white font-heading text-[20px] font-bold leading-[28px] truncate">
        {SITE.name} Portal
      </h1>
    </header>
  )
}
