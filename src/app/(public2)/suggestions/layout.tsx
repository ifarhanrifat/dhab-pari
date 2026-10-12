import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Community Input',
  description: 'Share suggestions, complaints, or volunteer for village initiatives.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
