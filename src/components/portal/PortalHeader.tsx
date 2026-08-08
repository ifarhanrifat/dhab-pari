'use client'

import { Menu } from 'lucide-react'

interface PortalHeaderProps {
  onMenuToggle?: () => void
}

export function PortalHeader({ onMenuToggle }: PortalHeaderProps) {
  return (
    // Menu button on the LEFT, same as the public and admin headers — the
    // sidebar slides in from the left, so the trigger belongs there.
    <header className="md:hidden bg-dp-primary px-4 py-4 flex items-center gap-2.5 sticky top-0 z-50">
      <button onClick={onMenuToggle} className="text-white p-1.5 -ml-1.5 shrink-0" aria-label="Toggle menu"><Menu size={26} /></button>
      <h1 className="text-white font-heading text-[20px] font-bold leading-[28px] truncate">Donor Portal</h1>
    </header>
  )
}
