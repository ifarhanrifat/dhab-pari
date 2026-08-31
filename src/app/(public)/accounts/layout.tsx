import type { Metadata } from 'next'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Marketplace',
  description: `Order from local shops and book seats on local rides — the ${SITE.name} community marketplace.`,
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
