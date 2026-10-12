import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Photo Gallery',
  description: 'Browse photos from village events, projects, and celebrations.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
