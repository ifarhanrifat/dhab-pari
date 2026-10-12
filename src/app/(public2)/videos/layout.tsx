import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Video Library',
  description: 'Watch village events, interviews, sports highlights, and project progress.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
