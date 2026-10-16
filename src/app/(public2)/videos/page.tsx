'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { Play, Eye } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Video {
  id: string
  title: string
  title_ur: string | null
  description: string | null
  video_url: string
  thumbnail_url: string | null
  category: string | null
  duration_seconds: number | null
  is_featured: boolean
  views: number
}

const categoryTabs = [
  'All',
  'Interview',
  'Wedding',
  'Event',
  'Sports',
  'Documentary',
  'Project',
  'Freelancing',
]

const categoryTabKeys: Record<string, string> = {
  All: 'x.catAll',
  Interview: 'x.catInterview',
  Wedding: 'x.catWedding',
  Event: 'x.catEvent',
  Sports: 'x.catSports',
  Documentary: 'x.catDocumentary',
  Project: 'x.catProject',
  Freelancing: 'x.catFreelancing',
}

const categoryBadgeKeys: Record<string, string> = {
  interview: 'x.catInterview',
  wedding: 'x.catWedding',
  event: 'x.catEvent',
  sports: 'x.catSports',
  documentary: 'x.catDocumentary',
  project: 'x.catProject',
  news: 'x.catNews',
  freelancing: 'x.catFreelancing',
}

const categoryBadgeColors: Record<string, string> = {
  interview: 'bg-blue-600',
  wedding: 'bg-pink-600',
  event: 'bg-indigo-600',
  sports: 'bg-emerald-600',
  documentary: 'bg-amber-600',
  project: 'bg-dp2-primary-dark',
  news: 'bg-red-600',
  freelancing: 'bg-dp2-primary-dark',
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideosPage() {
  const { t, isUrdu } = useLocale()
  const [videos, setVideos] = useState<Video[]>([])
  const [activeTab, setActiveTab] = useState('All')
  const [loading, setLoading] = useState(true)

  // Real bug, 2026-10-17: a transient fetch failure here used to look
  // identical to "genuinely no videos" — data ?? [] swallowed any error
  // silently, with no retry and nothing visible in the console. One
  // automatic retry covers the common transient case (a momentary auth
  // token refresh or network blip); a real, persisting error at least
  // now logs instead of vanishing.
  useEffect(() => {
    const supabase = createClient()
    let cancelled = false
    async function load(attempt = 1) {
      const { data, error } = await supabase
        .from('video_content')
        .select('*')
        .eq('is_published', true)
        .order('created_at', { ascending: false })
      if (cancelled) return
      if (error) {
        console.error('Failed to load videos', error)
        if (attempt < 2) { setTimeout(() => load(attempt + 1), 800); return }
      }
      setVideos(data ?? [])
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  const filtered =
    activeTab === 'All'
      ? videos
      : videos.filter(
          (v) => v.category?.toLowerCase() === activeTab.toLowerCase()
        )

  const featured = videos.filter((v) => v.is_featured)
  const interviews = filtered.filter((v) => v.category === 'interview')
  const otherVideos = filtered.filter((v) => v.category !== 'interview')

  return (
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-heading text-[23px] font-bold leading-[28px] text-dp2-primary section-title">
          {t('x.videoLibrary')}
        </h1>
        <p className="text-slate-500 font-sans text-[19px] leading-[20px] mt-2">
          {t('x.videoLibrarySubtitle')}
        </p>
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-3 mb-10">
        {categoryTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2 rounded-full font-sans text-[15px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
              activeTab === tab
                ? 'bg-dp2-primary text-white'
                : 'bg-white border border-dp2-card-border text-slate-500 hover:border-dp2-primary hover:text-dp2-primary'
            }`}
          >
            {t(categoryTabKeys[tab])}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="aspect-video bg-dp2-surface rounded-xl animate-pulse"
            />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-slate-500 font-sans text-[17px]">
          {t('x.noVideosCategory')}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-8">

          {/* Featured Videos (only show on "All" tab) */}
          {activeTab === 'All' && featured.length > 0 && (
            <section>
              <h2 className="font-heading text-[19px] font-bold leading-[24px] text-dp2-primary mb-6">
                {t('x.featured')}
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {featured.map((video) => (
                  <VideoCard key={video.id} video={video} large />
                ))}
              </div>
            </section>
          )}

          {/* Interviews Section — horizontal cards */}
          {interviews.length > 0 && (
            <section>
              <h2 className="font-heading text-[19px] font-bold leading-[24px] text-dp2-primary mb-6">
                {t('x.interviews')}
              </h2>
              <div className="space-y-4">
                {interviews.map((video) => (
                  <Link
                    key={video.id}
                    href={`/videos/${video.id}`}
                    className="bg-white border border-dp2-card-border rounded-2xl overflow-hidden flex flex-col sm:flex-row hover:border-dp2-primary-dark transition-all group cursor-pointer"
                  >
                    {/* Thumbnail — a real uploaded image when there is one, same
                        gradient placeholder as before when there isn't. Real
                        bug: thumbnail_url was fetched but never actually
                        rendered anywhere on this page, so an admin-uploaded
                        cover photo never showed up here no matter what. */}
                    <div className="w-full sm:w-48 md:w-64 aspect-video sm:aspect-auto shrink-0 relative bg-black">
                      {video.thumbnail_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={video.thumbnail_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-70 transition-opacity" />
                      ) : (
                        <div className="w-full h-full min-h-[120px] bg-gradient-to-br from-dp2-primary to-amber-100 opacity-60 group-hover:opacity-40 transition-opacity" />
                      )}
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Play size={18} className="text-white ms-0.5" fill="white" />
                        </div>
                      </div>
                      <div className="absolute bottom-2 end-2 bg-black/60 text-white text-[11px] px-2 py-0.5 rounded font-sans">
                        {formatDuration(video.duration_seconds)}
                      </div>
                    </div>
                    {/* Info */}
                    <div className="p-5 flex flex-col justify-center min-w-0">
                      <span className={`text-[11px] font-bold uppercase tracking-widest font-sans text-white px-2 py-0.5 rounded w-fit mb-2 ${categoryBadgeColors[video.category ?? ''] ?? 'bg-dp2-primary'}`}>
                        {video.category && t(categoryBadgeKeys[video.category.toLowerCase()] ?? '', video.category)}
                      </span>
                      {/* dir="ltr" pinned here deliberately — video.title has no
                          _ur column (it's always an English string, see the
                          detail page's own note on this), and truncating LTR
                          text inside an RTL-direction ancestor clips from the
                          wrong end: this is what showed "sheed - Village
                          Elder" instead of "Interview with Haji Rasheed -
                          Village Elder" live on an Urdu phone. */}
                      <h3 dir="ltr" className="text-start font-bold text-dp2-primary text-[17px] font-sans leading-[24px] group-hover:text-dp2-primary-dark transition-colors truncate">
                        {video.title}
                      </h3>
                      {video.title_ur && (
                        <p className="text-slate-500 text-[14px] mt-0.5 truncate" style={{ fontFamily: 'var(--font-urdu-ui)' }}>
                          {video.title_ur}
                        </p>
                      )}
                      {video.description && (
                        <p className="text-slate-500 text-[15px] font-sans mt-1 line-clamp-1">
                          {video.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-slate-500 text-[13px] font-sans">
                        <Eye size={12} />
                        <span>{video.views.toLocaleString()} {t('x.views')}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* Other videos — grid */}
          {otherVideos.length > 0 && (
            <section>
              {interviews.length > 0 && (
                <h2 className="font-heading text-[19px] font-bold leading-[24px] text-dp2-primary mb-6">
                  {activeTab === 'All' ? t('x.allVideos') : t(categoryTabKeys[activeTab])}
                </h2>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {otherVideos.map((video) => (
                  <VideoCard key={video.id} video={video} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function VideoCard({ video, large }: { video: Video; large?: boolean }) {
  const { t } = useLocale()
  return (
    <Link
      href={`/videos/${video.id}`}
      className="group relative rounded-xl overflow-hidden aspect-video bg-black cursor-pointer block"
    >
      {/* Thumbnail — real uploaded image when there is one, same gradient
          placeholder as before when there isn't (see the Interviews card
          above for the bug this fixes: thumbnail_url was never rendered
          anywhere on this page before). */}
      {video.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={video.thumbnail_url} alt="" className="absolute inset-0 w-full h-full object-cover opacity-90 group-hover:opacity-70 transition-opacity" />
      ) : (
        <div className="w-full h-full bg-gradient-to-br from-dp2-primary to-amber-100 opacity-60 group-hover:opacity-40 transition-opacity" />
      )}

      {/* Play button */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className={`${large ? 'w-16 h-16' : 'w-12 h-12'} bg-white/20 backdrop-blur rounded-full flex items-center justify-center group-hover:scale-110 transition-transform`}>
          <Play size={large ? 28 : 22} className="text-white ms-1" fill="white" />
        </div>
      </div>

      {/* Duration */}
      <div className="absolute bottom-2 end-2 bg-black/60 text-white text-[11px] px-2 py-1 rounded font-sans">
        {formatDuration(video.duration_seconds)}
      </div>

      {/* Category badge */}
      <div className="absolute top-3 start-3">
        <span className={`text-[11px] font-bold uppercase tracking-widest font-sans text-white px-2 py-1 rounded ${categoryBadgeColors[video.category ?? ''] ?? 'bg-dp2-primary'}`}>
          {video.category && t(categoryBadgeKeys[video.category.toLowerCase()] ?? '', video.category)}
        </span>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
        {/* dir="ltr" — video.title has no _ur column, always English; see
            the Interviews card's note on why truncating it inside an RTL
            ancestor clips from the wrong end otherwise. */}
        <p dir="ltr" className="text-start text-white font-bold text-[15px] font-sans tracking-[0.05em] truncate">
          {video.title}
        </p>
        {video.title_ur && (
          <p className="text-white/80 text-[13.5px] truncate" style={{ fontFamily: 'var(--font-urdu-ui)' }}>
            {video.title_ur}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1 text-white/70 text-[13px] font-sans">
          <Eye size={12} />
          <span>{video.views.toLocaleString()} {t('x.views')}</span>
        </div>
      </div>
    </Link>
  )
}
