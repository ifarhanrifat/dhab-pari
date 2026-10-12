import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Village News',
  description: 'Stay informed about community events, announcements, and village development.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
