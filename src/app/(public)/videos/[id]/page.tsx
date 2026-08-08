import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Eye, Calendar, Tag } from 'lucide-react'
import { VideoPlayer } from '@/components/VideoPlayer'

// A published video rarely changes and isn't per-visitor (view count here is
// a display-only column, not incremented by this render).
export const revalidate = 300

export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: video } = await supabase
    .from('video_content')
    .select('*')
    .eq('id', id)
    .eq('is_published', true)
    .single()

  if (!video) notFound()

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10">
      <Link
        href="/videos"
        className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8"
      >
        <ArrowLeft size={16} />
        Back to Videos
      </Link>

      <div className="max-w-4xl mx-auto">
        <VideoPlayer url={video.video_url} title={video.title} />

        <div className="mt-6">
          {video.category && (
            <span className="inline-flex items-center gap-1 bg-dp-primary-container text-dp-on-primary-container px-3 py-1 rounded-full text-[12px] font-bold font-sans uppercase mb-3">
              <Tag size={12} />
              {video.category}
            </span>
          )}

          <h1 className="font-heading text-[28px] md:text-[32px] font-bold leading-[36px] md:leading-[40px] text-dp-primary mb-2">
            {video.title}
          </h1>

          {video.title_ur && (
            <p
              className="text-dp-on-surface-variant text-[20px] mb-4"
              style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5', direction: 'rtl' }}
            >
              {video.title_ur}
            </p>
          )}

          <div className="flex items-center gap-4 text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em] mb-6 pb-6 border-b border-dp-outline-variant">
            <span className="flex items-center gap-1">
              <Eye size={14} />
              {video.views.toLocaleString()} views
            </span>
            <span className="flex items-center gap-1">
              <Calendar size={14} />
              {new Date(video.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
          </div>

          {video.description && (
            <p className="font-sans text-[18px] leading-[28px] text-dp-on-surface-variant">
              {video.description}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
