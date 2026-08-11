import type { Metadata } from 'next'
import { SITE } from '@/lib/constants'

export const metadata: Metadata = {
  title: 'Village Projects',
  description: `Track community-funded infrastructure, healthcare, and education projects in ${SITE.name}.`,
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
