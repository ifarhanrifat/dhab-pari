'use client'

import { createContext, useContext, useState } from 'react'

// The slide-out menu is rendered by Header, but the bottom bar's "More"
// button needs to open it too. Previously "More" linked to /more — a route
// that never existed, so it 404'd (and Next even prefetched the 404).
// Sharing the open/closed state here lets both trigger the same drawer.
interface MobileNavState {
  open: boolean
  setOpen: (open: boolean) => void
}

const Ctx = createContext<MobileNavState>({ open: false, setOpen: () => {} })

export function MobileNavProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>
}

export const useMobileNav = () => useContext(Ctx)
