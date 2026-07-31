'use client'

import { use as usePromise } from 'react'
import { DailyRegisterView } from '@/components/admin/DailyRegisterView'

type SystemTab = 'water_supply' | 'donors_projects'

export default function DailyRegisterPage({ params }: { params: Promise<{ system: string }> }) {
  const { system: rawSystem } = usePromise(params)
  const system = (rawSystem === 'donors_projects' ? 'donors_projects' : 'water_supply') as SystemTab

  return <DailyRegisterView system={system} backHref={`/admin/finance/${system}`} />
}
