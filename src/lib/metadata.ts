import type { Metadata } from 'next'
import { SITE } from './constants'

const base = {
  siteName: `${SITE.name} ${SITE.committee}`,
  url: `https://${SITE.domain}`,
}

export function createMetadata(page: {
  title: string
  description: string
  path?: string
}): Metadata {
  const fullTitle = `${page.title} | ${base.siteName}`
  const url = `${base.url}${page.path ?? ''}`

  return {
    title: fullTitle,
    description: page.description,
    openGraph: {
      title: fullTitle,
      description: page.description,
      url,
      siteName: base.siteName,
      locale: 'en_US',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description: page.description,
    },
    alternates: {
      canonical: url,
    },
  }
}
