'use client'

// Real bug, reported live: mobility routes (my-vehicle/*, marketplace/
// (mobility)/*) render their own MobilityHeader instead of PortalHeader,
// and MobilityHeader never had a hamburger button at all — PortalSidebar
// is `hidden md:flex` (desktop-only), so on any narrower viewport there
// was genuinely no way to open it from these routes, full stop. This
// context lets the dashboard layout (which owns the sidebar's open
// state) hand a toggle function down to MobilityHeader, which is
// rendered by a nested layout rather than a direct child.

import { createContext, useContext } from 'react'

const PortalMobileNavContext = createContext<(() => void) | null>(null)

export function PortalMobileNavProvider({ onOpen, children }: { onOpen: () => void; children: React.ReactNode }) {
  return <PortalMobileNavContext.Provider value={onOpen}>{children}</PortalMobileNavContext.Provider>
}

export function usePortalMobileNavToggle() {
  return useContext(PortalMobileNavContext)
}
