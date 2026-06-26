import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Village Projects',
  description: 'Track community-funded infrastructure, healthcare, and education projects in Dhab Pari.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
