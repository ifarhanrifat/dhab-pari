'use client'

import { use } from 'react'
import { SystemGuard } from '@/components/admin/SystemGuard'

// Covers the workspace, its register and its recurring page in one place, so a
// route added under /admin/finance/[system]/ later is guarded by existing —
// rather than by somebody remembering to add a check.
export default function FinanceSystemLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ system: string }>
}) {
  const { system: raw } = use(params)
  const system = raw === 'donors_projects' ? 'donors_projects' : 'water_supply'

  return <SystemGuard system={system}>{children}</SystemGuard>
}
