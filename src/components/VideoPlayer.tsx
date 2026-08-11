'use client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface VideoPlayerProps {
  url: string
  title?: string
}

function getYouTubeId(url: string): string | null {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return match?.[1] ?? null
}

export function VideoPlayer({ url, title }: VideoPlayerProps) {
  const { t } = useLocale()
  const ytId = getYouTubeId(url)

  if (ytId) {
    return (
      <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-black">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${ytId}`}
          title={title ?? 'Video'}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 w-full h-full"
        />
      </div>
    )
  }

  return (
    <div className="relative w-full aspect-video rounded-lg overflow-hidden bg-black">
      <video controls className="w-full h-full" preload="metadata">
        <source src={url} />
        {t('y.videoUnsupported')}
      </video>
    </div>
  )
}
