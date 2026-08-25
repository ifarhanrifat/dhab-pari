import { youtubeEmbedUrl, isYoutubeUrl } from '@/lib/videoEmbed'

// A YouTube link renders as an actual embedded player; an uploaded file
// (Supabase storage, via VideoUpload) renders as a plain <video> tag.
// Shared by Talent Showcase's admin/portal/public surfaces so the same
// video shows up embedded everywhere it appears, not just linked out.
export function VideoEmbed({ url, className }: { url: string; className?: string }) {
  if (isYoutubeUrl(url)) {
    const embedUrl = youtubeEmbedUrl(url)
    if (!embedUrl) return null
    return (
      <div className={`relative w-full ${className ?? ''}`} style={{ aspectRatio: '16/9' }}>
        <iframe
          src={embedUrl}
          title="Video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          className="absolute inset-0 w-full h-full rounded-lg"
        />
      </div>
    )
  }
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video src={url} controls className={`w-full rounded-lg bg-black ${className ?? ''}`} style={{ aspectRatio: '16/9' }} />
  )
}
