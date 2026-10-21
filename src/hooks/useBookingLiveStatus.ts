'use client'

// Real gap found 2026-10-21: every "pending decision" booking screen in
// this app (BookingQuickViewSheet included) fetches its status once on
// mount and never again — a rider has to manually re-open it to find out
// the driver responded. PortalNotificationBell.tsx already proves out
// the right pattern in production (a Realtime postgres_changes
// subscription + a poll fallback for the gap while a channel is still
// connecting/reconnecting); this generalizes that same pattern to watch
// one specific row instead of a notifications feed, for any "is my
// request still pending" screen to use.
//
// Deliberately generic over {table, id} rather than one hook per
// vertical — hourly_bookings/rental_bookings/equipment_bookings/
// ride_bookings all just need "tell me the instant this one row's
// status column changes," nothing vertical-specific.

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export function useBookingLiveStatus<T extends { id: string }>(
  table: string,
  id: string | null,
  select: string,
  pollMs = 5000,
): { row: T | null; loading: boolean; refresh: () => void } {
  const supabase = createClient()
  const [row, setRow] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  // A ref so the realtime handler and the poll both always write through
  // the same path without needing to be redeclared as effect deps.
  const loadRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!id) { setRow(null); setLoading(false); return }
    let cancelled = false
    const load = () => {
      supabase.from(table).select(select).eq('id', id).maybeSingle().then(({ data }) => {
        if (!cancelled) { setRow(data as T | null); setLoading(false) }
      })
    }
    loadRef.current = load
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, id, select])

  useEffect(() => {
    if (!id) return
    const channel = supabase
      .channel(`booking_live:${table}:${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter: `id=eq.${id}` }, () => loadRef.current())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, id])

  useEffect(() => {
    if (!id) return
    const iv = setInterval(() => loadRef.current(), pollMs)
    return () => clearInterval(iv)
  }, [id, pollMs])

  return { row, loading, refresh: () => loadRef.current() }
}
