'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { Calendar, User, Eye } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface NewsPost {
  id: string
  title: string
  title_ur: string | null
  content: string
  content_ur: string | null
  category: string | null
  cover_image_url: string | null
  author: string
  views: number
  published_at: string | null
}

interface PostCategory { key: string; label_en: string; icon: string | null }

const categoryColors: Record<string, { bg: string; text: string; accent: string }> = {
  sports: { bg: 'bg-emerald-50', text: 'text-emerald-700', accent: 'bg-emerald-600' },
  education: { bg: 'bg-blue-50', text: 'text-blue-700', accent: 'bg-blue-600' },
  health: { bg: 'bg-rose-50', text: 'text-rose-700', accent: 'bg-rose-600' },
  environment: { bg: 'bg-green-50', text: 'text-green-700', accent: 'bg-green-600' },
  social: { bg: 'bg-purple-50', text: 'text-purple-700', accent: 'bg-purple-600' },
  announcement: { bg: 'bg-amber-50', text: 'text-amber-700', accent: 'bg-amber-600' },
  event: { bg: 'bg-indigo-50', text: 'text-indigo-700', accent: 'bg-indigo-600' },
  editorial: { bg: 'bg-slate-50', text: 'text-slate-700', accent: 'bg-slate-600' },
  poetry: { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', accent: 'bg-fuchsia-600' },
  blog: { bg: 'bg-cyan-50', text: 'text-cyan-700', accent: 'bg-cyan-600' },
}

const categoryEmojis: Record<string, string> = {
  sports: '⚽',
  education: '🎓',
  health: '🩺',
  environment: '🌿',
  social: '🤝',
  announcement: '📢',
  event: '🎉',
  editorial: '✍️',
  poetry: '🖋️',
  blog: '📝',
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export default function NewsPage() {
  const { t } = useLocale()
  const [posts, setPosts] = useState<NewsPost[]>([])
  const [activeFilter, setActiveFilter] = useState('All')
  const [categories, setCategories] = useState<PostCategory[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('news_posts')
      .select('*')
      .eq('is_published', true)
      .order('published_at', { ascending: false })
      .then(({ data }) => {
        setPosts(data ?? [])
        setLoading(false)
      })
    supabase.from('post_categories').select('key, label_en, icon').eq('is_active', true).order('display_order')
      .then(({ data }) => setCategories(data ?? []))
  }, [])

  const filtered =
    activeFilter === 'All'
      ? posts
      : posts.filter(
          (p) => p.category?.toLowerCase() === activeFilter.toLowerCase()
        )

  const featured = filtered[0]
  const rest = filtered.slice(1)

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title">
          {t('x.villageNewsUpdates')}
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px] mt-2">
          {t('x.newsPageIntro')}
        </p>
      </div>

      {/* Category Filters */}
      <div className="flex flex-wrap gap-3 mb-10">
        {/* cat.label_en is a database value (post_categories has no Urdu
            label column yet) — every OTHER category still shows in
            English regardless of site language, a real gap this "All"
            pill alone can't fix; flagged as a follow-up rather than
            guessed at here. */}
        {[{ key: 'All', label_en: t('x.allCategories'), icon: null }, ...categories].map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveFilter(cat.key)}
            className={`px-5 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
              activeFilter === cat.key
                ? 'bg-dp-primary text-white'
                : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary hover:text-dp-primary'
            }`}
          >
            {cat.icon ? `${cat.icon} ` : ''}{cat.label_en}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-6">
          <div className="h-[280px] bg-white border border-dp-outline-variant rounded-lg animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[260px] bg-white border border-dp-outline-variant rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">
          {t('x.noNewsCategory')}
        </div>
      )}

      {!loading && featured && (
        <>
          {/* Featured Post */}
          <Link href={`/news/${featured.id}`} className="mb-10 bg-white border border-dp-outline-variant rounded-lg overflow-hidden grid grid-cols-1 md:grid-cols-2 hover:border-dp-secondary transition-all group cursor-pointer block">
            {/* Left: colored area */}
            <div className={`min-h-[240px] flex items-center justify-center ${categoryColors[featured.category ?? '']?.bg ?? 'bg-dp-surface-container-low'}`}>
              <span className="text-[80px]">
                {categoryEmojis[featured.category ?? ''] ?? '📰'}
              </span>
            </div>
            {/* Right: content */}
            <div className="p-8 flex flex-col justify-between">
              <div>
                <span className={`text-[10px] font-bold uppercase tracking-widest font-sans ${categoryColors[featured.category ?? '']?.text ?? 'text-dp-secondary'}`}>
                  {featured.category}
                </span>
                <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mt-2 group-hover:text-dp-secondary transition-colors">
                  {featured.title}
                </h2>
                <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[24px] mt-3 line-clamp-3">
                  {featured.content}
                </p>
              </div>
              <div className="flex items-center gap-4 mt-6 text-dp-on-surface-variant text-[14px] font-sans font-semibold tracking-[0.05em]">
                <span className="flex items-center gap-1">
                  <Calendar size={14} />
                  {formatDate(featured.published_at)}
                </span>
                <span className="flex items-center gap-1">
                  <User size={14} />
                  {featured.author}
                </span>
                <span className="flex items-center gap-1">
                  <Eye size={14} />
                  {featured.views}
                </span>
              </div>
            </div>
          </Link>

          {/* Grid of remaining posts */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {rest.map((post) => {
              const colors = categoryColors[post.category ?? ''] ?? {
                bg: 'bg-dp-surface-container-low',
                text: 'text-dp-secondary',
                accent: 'bg-dp-secondary',
              }
              return (
                <Link
                  key={post.id}
                  href={`/news/${post.id}`}
                  className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden hover:border-dp-secondary transition-all group cursor-pointer block"
                >
                  {/* Colored cover */}
                  <div className={`h-32 flex items-center justify-center ${colors.bg}`}>
                    <span className="text-[48px]">
                      {categoryEmojis[post.category ?? ''] ?? '📰'}
                    </span>
                  </div>
                  {/* Content */}
                  <div className="p-5">
                    <span className={`text-[10px] font-bold uppercase tracking-widest font-sans ${colors.text}`}>
                      {post.category}
                    </span>
                    <h3 className="font-bold text-dp-primary text-[16px] font-sans leading-[24px] mt-1 group-hover:text-dp-secondary transition-colors line-clamp-2">
                      {post.title}
                    </h3>
                    <p className="text-dp-on-surface-variant text-[14px] font-sans tracking-[0.05em] mt-2 line-clamp-2">
                      {post.content?.slice(0, 100)}...
                    </p>
                    <div className="flex items-center gap-3 mt-4 text-dp-on-surface-variant text-[12px] font-sans">
                      <span className="flex items-center gap-1">
                        <Calendar size={12} />
                        {formatDate(post.published_at)}
                      </span>
                      <span className="flex items-center gap-1">
                        <User size={12} />
                        {post.author}
                      </span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
