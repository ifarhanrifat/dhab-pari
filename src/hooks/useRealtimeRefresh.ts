import { useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'

// The Realtime half of what the old "poll every few seconds hoping
// something changed" screens were missing (Part A2 of the mobility
// plan, 2026-10-28) — reuses the exact channel/postgres_changes shape
// PortalNotificationBell.tsx already proves out in production, just
// generalized to any single row instead of one hardcoded table. Still
// keeps a slower poll underneath as a fallback for a dropped
// websocket, same belt-and-suspenders the bell itself uses — this
// never replaces the poll outright, it just makes the common case
// (someone else changed the row) land instantly instead of up to
// `pollMs` late.
//
// Sibling to useBookingLiveStatus (726), not a replacement for it —
// that one owns its own raw `.select()` and hands back the row;
// callers here (ride_dispatch_requests, dispatch_calls) need their own
// RPC-shaped reload (joined category/tenant names, tier-advancement
// side effects a plain select can't do), so this takes a caller-
// supplied reload callback instead of a select string.
//
// A table only actually delivers postgres_changes events once it's in
// the `supabase_realtime` publication (726 found this the hard way for
// four other tables) — adding a new caller here needs that too.
export function useRealtimeRefresh(table: string, id: string | null | undefined, reload: () => void, pollMs = 15000) {
  const supabase = createClient()
  // A ref, not a dependency — re-subscribing the whole channel every
  // time the caller's reload closure changes identity (which happens
  // every render for an inline function) would mean constant
  // resubscribe churn instead of one subscription held for the row's
  // lifetime.
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    if (!id) return
    reloadRef.current()
    const channel = supabase
      .channel(`${table}:${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter: `id=eq.${id}` }, () => reloadRef.current())
      .subscribe()
    const iv = setInterval(() => reloadRef.current(), pollMs)
    return () => { supabase.removeChannel(channel); clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, id, pollMs])
}
