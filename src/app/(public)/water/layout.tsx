import type { Metadata } from 'next'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Water Bill Lookup',
  description: `Check your water bill status and payment history for ${SITE.name} village.`,
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
