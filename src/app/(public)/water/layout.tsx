import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Water Bill Lookup',
  description: 'Check your water bill status and payment history for Dhab Pari village.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
