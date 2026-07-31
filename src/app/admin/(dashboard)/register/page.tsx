'use client'

import { useEffect, useState } from 'react'
import { DailyRegisterView } from '@/components/admin/DailyRegisterView'
import { useSystemAccess } from '@/hooks/useSystemAccess'

type SystemTab = 'water_supply' | 'donors_projects'

export default function RegisterPage() {
  const access = useSystemAccess()
  const [system, setSystem] = useState<SystemTab>('water_supply')
  const [systemOverride] = useState<SystemTab | null>(() => {
    if (typeof window === 'undefined') return null
    const p = new URLSearchParams(window.location.search).get('system')
    return p === 'water_supply' || p === 'donors_projects' ? p : null
  })
  useEffect(() => {
    if (access.loading) return
    if (systemOverride === 'water_supply' && access.canWaterSupply) { setSystem('water_supply'); return }
    if (systemOverride === 'donors_projects' && access.canDonorsProjects) { setSystem('donors_projects'); return }
    setSystem(access.defaultSystem)
  }, [access.loading, access.defaultSystem, access.canWaterSupply, access.canDonorsProjects, systemOverride])

  return (
    <>
      <div className="flex items-center justify-between mb-6 print:hidden gap-4 flex-wrap">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary">Daily Register</h1>
        {!access.loading && (access.canWaterSupply || access.canDonorsProjects) && (
          <div className="flex items-center gap-1 bg-dp-surface-container-low rounded-lg p-1">
            {access.canWaterSupply && (
              <button
                onClick={() => setSystem('water_supply')}
                className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'water_supply' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}
              >
                Water Supply
              </button>
            )}
            {access.canDonorsProjects && (
              <button
                onClick={() => setSystem('donors_projects')}
                className={`px-3 py-1.5 rounded-md text-[13px] font-sans font-semibold cursor-pointer transition-all ${system === 'donors_projects' ? 'bg-dp-secondary text-white' : 'text-dp-on-surface-variant'}`}
              >
                Donors &amp; Projects
              </button>
            )}
          </div>
        )}
      </div>
      <DailyRegisterView system={system} />
    </>
  )
}
