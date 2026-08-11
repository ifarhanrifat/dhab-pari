import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'

// A published article rarely changes and isn't per-visitor (view count here
// is a display-only column, not incremented by this render).
export const revalidate = 300
import Link from 'next/link'
import { Calendar, User, Eye, ArrowLeft } from 'lucide-react'
import { T } from '@/components/i18n/T'

const categoryColors: Record<string, { bg: string; text: string }> = {
  sports: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  education: { bg: 'bg-blue-100', text: 'text-blue-700' },
  health: { bg: 'bg-rose-100', text: 'text-rose-700' },
  environment: { bg: 'bg-green-100', text: 'text-green-700' },
  social: { bg: 'bg-purple-100', text: 'text-purple-700' },
  announcement: { bg: 'bg-amber-100', text: 'text-amber-700' },
  event: { bg: 'bg-indigo-100', text: 'text-indigo-700' },
}

const categoryEmojis: Record<string, string> = {
  sports: '⚽',
  education: '🎓',
  health: '🩺',
  environment: '🌿',
  social: '🤝',
  announcement: '📢',
  event: '🎉',
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

export default async function NewsDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: post } = await supabase
    .from('news_posts')
    .select('*')
    .eq('id', id)
    .eq('is_published', true)
    .single()

  if (!post) notFound()

  const colors = categoryColors[post.category ?? ''] ?? {
    bg: 'bg-dp-surface-container-low',
    text: 'text-dp-secondary',
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10">
      {/* Back link */}
      <Link
        href="/news"
        className="inline-flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline mb-8"
      >
        <ArrowLeft size={16} />
        <T k="x.backToNews" />
      </Link>

      <article className="max-w-3xl mx-auto">
        {/* Cover area */}
        <div
          className={`w-full h-48 md:h-64 rounded-lg flex items-center justify-center mb-8 ${colors.bg}`}
        >
          <span className="text-[80px]">
            {categoryEmojis[post.category ?? ''] ?? '📰'}
          </span>
        </div>

        {/* Category badge */}
        <span
          className={`inline-block text-[12px] font-bold uppercase tracking-widest font-sans px-3 py-1 rounded-full mb-4 ${colors.bg} ${colors.text}`}
        >
          {post.category}
        </span>

        {/* Title */}
        <h1 className="font-heading text-[32px] md:text-[40px] font-bold leading-[40px] md:leading-[48px] text-dp-primary mb-4">
          {post.title}
        </h1>

        {/* Urdu title */}
        {post.title_ur && (
          <p
            className="text-dp-on-surface-variant text-[22px] mb-6"
            style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5', direction: 'rtl' }}
          >
            {post.title_ur}
          </p>
        )}

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-4 text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em] mb-8 pb-8 border-b border-dp-outline-variant">
          <span className="flex items-center gap-1">
            <Calendar size={16} />
            {formatDate(post.published_at)}
          </span>
          <span className="flex items-center gap-1">
            <User size={16} />
            {post.author}
          </span>
          <span className="flex items-center gap-1">
            <Eye size={16} />
            {post.views} views
          </span>
        </div>

        {/* Content */}
        <div className="prose-dp">
          {post.content.split('\n').map((paragraph: string, i: number) => (
            <p
              key={i}
              className="text-dp-on-surface font-sans text-[18px] leading-[28px] mb-4"
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* Urdu content */}
        {post.content_ur && (
          <div className="mt-8 pt-8 border-t border-dp-outline-variant">
            <h3 className="font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant uppercase mb-4">
              اردو میں پڑھیں
            </h3>
            {post.content_ur.split('\n').map((paragraph: string, i: number) => (
              <p
                key={i}
                className="text-dp-on-surface text-[18px] mb-4"
                style={{
                  fontFamily: 'var(--font-urdu), serif',
                  lineHeight: '2.5',
                  direction: 'rtl',
                }}
              >
                {paragraph}
              </p>
            ))}
          </div>
        )}
      </article>
    </div>
  )
}
