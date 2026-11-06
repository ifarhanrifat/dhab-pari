// The committee's per-service fare policy (migration 776's
// service_fare_policies), read once per page load and shared by every
// booking window and driver screen that shows the fare rules.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type FareService = 'hourly' | 'rental' | 'machinery' | 'tractor' | 'loader' | 'shadi'

export interface FarePolicy {
  service_key: FareService
  free_radius_km: number
  travel_rate_per_km_pkr: number
  max_distance_km: number | null
  advance_pct: number
  overtime_grace_minutes: number
  overtime_block_minutes: number
  overtime_rate_pct: number
  full_day_hours: number | null
  notes_en: string | null
  notes_ur: string | null
}

export interface TravelQuote {
  known: boolean
  road_km: number | null
  free_radius_km: number
  travel_km: number
  travel_rate_per_km_pkr: number
  travel_charge_pkr: number
  max_distance_km: number | null
  too_far: boolean
}

let cache: Promise<FarePolicy[]> | null = null

export function loadFarePolicies(force = false): Promise<FarePolicy[]> {
  if (!cache || force) {
    cache = Promise.resolve(createClient().rpc('service_fare_policies_list'))
      .then(({ data }) => ((data ?? []) as FarePolicy[]).map((p) => ({
        ...p,
        free_radius_km: Number(p.free_radius_km), travel_rate_per_km_pkr: Number(p.travel_rate_per_km_pkr),
        max_distance_km: p.max_distance_km == null ? null : Number(p.max_distance_km), advance_pct: Number(p.advance_pct),
        overtime_rate_pct: Number(p.overtime_rate_pct), full_day_hours: p.full_day_hours == null ? null : Number(p.full_day_hours),
      })))
      .catch(() => { cache = null; return [] })
  }
  return cache
}

export function useFarePolicy(service: FareService | null): FarePolicy | null {
  const [policy, setPolicy] = useState<FarePolicy | null>(null)
  useEffect(() => {
    if (!service) return
    let live = true
    loadFarePolicies().then((all) => { if (live) setPolicy(all.find((p) => p.service_key === service) ?? null) })
    return () => { live = false }
  }, [service])
  return policy
}

// Hourly overtime exactly as end_hourly_trip bills it, for the live meter.
export function hourlyOvertime(policy: FarePolicy | null, bookedHours: number, startedAt: string | null, hourlyRate: number, now = Date.now(), pausedMinutes = 0) {
  if (!policy || !startedAt) return { minutes: 0, amount: 0 }
  // Paused time (813) never counts toward the booked hours — mirrors
  // end_hourly_trip's own elapsed-minus-paused math exactly, so this
  // live preview never disagrees with what actually gets billed.
  const elapsedMin = Math.max(0, (now - new Date(startedAt).getTime()) / 60000 - pausedMinutes)
  const over = elapsedMin - bookedHours * 60 - policy.overtime_grace_minutes
  if (over <= 0) return { minutes: 0, amount: 0 }
  const minutes = Math.ceil(over / policy.overtime_block_minutes) * policy.overtime_block_minutes
  return { minutes, amount: Math.round(hourlyRate * minutes / 60 * policy.overtime_rate_pct / 100) }
}
