'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

type SystemTab = 'water_supply' | 'donors_projects'

// Single source of truth for "which systems can this logged-in user see" — calls the
// same can_access_system() RPC the database's own RLS policies are built on, so it
// can never drift out of sync with what the server actually allows. This is purely
// so a role-restricted user (water_accountant/donor_accountant) doesn't see a system
// toggle option that would just render an empty, confusing screen — RLS is still the
// real security boundary regardless of what this returns.
export function useSystemAccess() {
  const [canWaterSupply, setCanWaterSupply] = useState<boolean | null>(null)
  const [canDonorsProjects, setCanDonorsProjects] = useState<boolean | null>(null)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.rpc('can_access_system', { p_system: 'water_supply' }),
      supabase.rpc('can_access_system', { p_system: 'donors_projects' }),
    ]).then(([water, donor]) => {
      setCanWaterSupply(!!water.data)
      setCanDonorsProjects(!!donor.data)
    })
  }, [])

  const loading = canWaterSupply === null || canDonorsProjects === null
  const defaultSystem: SystemTab = canWaterSupply === false && canDonorsProjects === true ? 'donors_projects' : 'water_supply'

  return { canWaterSupply: !!canWaterSupply, canDonorsProjects: !!canDonorsProjects, loading, defaultSystem }
}
