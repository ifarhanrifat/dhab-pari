'use client'

// Renders a lucide-react icon by NAME (icon names live as plain strings
// in src/lib/shopTypes.ts's data, not JSX imports — they come from a
// data structure, not code). Falls back to a generic icon if a name
// somehow doesn't resolve, rather than crashing the page — every name
// actually used in shopTypes.ts was cross-checked against a confirmed-
// exists list, but this is a free safety net against a future typo.

import { icons, type LucideProps } from 'lucide-react'
import { Package } from 'lucide-react'

interface Props extends LucideProps {
  name: string
}

export function DynamicIcon({ name, ...props }: Props) {
  const Icon = icons[name as keyof typeof icons] ?? Package
  return <Icon {...props} />
}
