// Turns a YouTube watch/share URL into an embeddable one, or tells the
// caller it's a direct video file (Supabase storage upload via VideoUpload)
// instead. No existing helper for this anywhere in the app — every other
// video surface just links out rather than embedding inline.
export function youtubeEmbedUrl(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtube\.com\/live\/|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{6,})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return `https://www.youtube.com/embed/${m[1]}`
  }
  return null
}

export function isYoutubeUrl(url: string): boolean {
  return url.includes('youtube.com') || url.includes('youtu.be')
}
