import { PublicChrome2 } from '@/components/design2/PublicChrome2'

// Phase 2 of the card-based redesign, 2026-10-12. Every individual
// public page re-skinned onto the new design moves into this route
// group (same technique the homepage used in Phase 1 -- see (home)/) so
// it gets the NEW chrome instead of (public)/layout.tsx's old
// Header/Footer/BottomNav/AnnouncementBar. Pages not yet re-skinned stay
// in (public) untouched until their own turn.
export default function Public2Layout({ children }: { children: React.ReactNode }) {
  return <PublicChrome2>{children}</PublicChrome2>
}
