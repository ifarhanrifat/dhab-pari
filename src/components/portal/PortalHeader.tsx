'use client'

import { Menu } from 'lucide-react'

interface PortalHeaderProps {
  onMenuToggle?: () => void
}

export function PortalHeader({ onMenuToggle }: PortalHeaderProps) {
  return (
    <header className="md:hidden bg-dp-primary px-4 py-4 flex items-center justify-between sticky top-0 z-50">
      <h1 className="text-white font-heading text-[20px] font-bold leading-[28px]">Donor Portal</h1>
      <button onClick={onMenuToggle} className="text-white p-1" aria-label="Toggle menu"><Menu size={24} /></button>
    </header>
  )
}
