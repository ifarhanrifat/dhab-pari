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
]

const categoryBadgeColors: Record<string, string> = {
  interview: 'bg-blue-600',
  wedding: 'bg-pink-600',
  event: 'bg-indigo-600',
  sports: 'bg-emerald-600',
  documentary: 'bg-amber-600',
  project: 'bg-dp-primary-container',
  news: 'bg-red-600',
}

function formatDuration(seconds: number | null) {
  if (!seconds) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VideosPage() {
  const { t } = useLocale()
  const [videos, setVideos] = useState<Video[]>([])
  const [activeTab, setActiveTab] = useState('All')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase
      .from('video_content')
      .select('*')
      .eq('is_published', true)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setVideos(data ?? [])
        setLoading(false)
      })
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
    <div className="max-w-[1200px] mx-auto px-6 md:px-12 py-10 min-h-screen">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title">
          {t('x.videoLibrary')}
        </h1>
        <p className="text-dp-on-surface-variant font-sans text-[18px] leading-[28px] mt-2">
          Watch village events, interviews, sports highlights, and project progress updates.
        </p>
      </div>

      {/* Category Tabs */}
      <div className="flex flex-wrap gap-3 mb-10">
        {categoryTabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-5 py-2 rounded-full font-sans text-[14px] font-semibold tracking-[0.05em] transition-all cursor-pointer ${
              activeTab === tab
                ? 'bg-dp-primary text-white'
                : 'bg-white border border-dp-outline-variant text-dp-on-surface-variant hover:border-dp-primary hover:text-dp-primary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="aspect-video bg-dp-surface-container rounded-lg animate-pulse"
            />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-dp-on-surface-variant font-sans text-[16px]">
          {t('x.noVideosCategory')}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="space-y-8">

          {/* Featured Videos (only show on "All" tab) */}
          {activeTab === 'All' && featured.length > 0 && (
            <section>
              <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
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
              <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
                {t('x.interviews')}
              </h2>
              <div className="space-y-4">
                {interviews.map((video) => (
                  <Link
                    key={video.id}
                    href={`/videos/${video.id}`}
                    className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden flex hover:border-dp-secondary transition-all group cursor-pointer"
                  >
                    {/* Thumbnail left */}
                    <div className="w-48 md:w-64 shrink-0 relative bg-black">
                      <div className="w-full h-full min-h-[120px] bg-gradient-to-br from-dp-primary to-dp-tertiary-container opacity-60 group-hover:opacity-40 transition-opacity" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-10 h-10 bg-white/20 backdrop-blur rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Play size={18} className="text-white ms-0.5" fill="white" />
                        </div>
                      </div>
                      <div className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] px-2 py-0.5 rounded font-sans">
                        {formatDuration(video.duration_seconds)}
                      </div>
                    </div>
                    {/* Info right */}
                    <div className="p-5 flex flex-col justify-center min-w-0">
                      <span className={`text-[10px] font-bold uppercase tracking-widest font-sans text-white px-2 py-0.5 rounded w-fit mb-2 ${categoryBadgeColors[video.category ?? ''] ?? 'bg-dp-primary'}`}>
                        {video.category}
                      </span>
                      <h3 className="font-bold text-dp-primary text-[16px] font-sans leading-[24px] group-hover:text-dp-secondary transition-colors truncate">
                        {video.title}
                      </h3>
                      {video.description && (
                        <p className="text-dp-on-surface-variant text-[14px] font-sans mt-1 line-clamp-1">
                          {video.description}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-dp-on-surface-variant text-[12px] font-sans">
                        <Eye size={12} />
                        <span>{video.views.toLocaleString()} views</span>
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
                <h2 className="font-heading text-[24px] font-bold leading-[32px] text-dp-primary mb-6">
                  {activeTab === 'All' ? 'All Videos' : activeTab}
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
  return (
    <Link
      href={`/videos/${video.id}`}
      className="group relative rounded-lg overflow-hidden aspect-video bg-black cursor-pointer block"
    >
      {/* Thumbnail bg */}
      <div className="w-full h-full bg-gradient-to-br from-dp-primary to-dp-tertiary-container opacity-60 group-hover:opacity-40 transition-opacity" />

      {/* Play button */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className={`${large ? 'w-16 h-16' : 'w-12 h-12'} bg-white/20 backdrop-blur rounded-full flex items-center justify-center group-hover:scale-110 transition-transform`}>
          <Play size={large ? 28 : 22} className="text-white ms-1" fill="white" />
        </div>
      </div>

      {/* Duration */}
      <div className="absolute bottom-2 right-2 bg-black/60 text-white text-[10px] px-2 py-1 rounded font-sans">
        {formatDuration(video.duration_seconds)}
      </div>

      {/* Category badge */}
      <div className="absolute top-3 left-3">
        <span className={`text-[10px] font-bold uppercase tracking-widest font-sans text-white px-2 py-1 rounded ${categoryBadgeColors[video.category ?? ''] ?? 'bg-dp-primary'}`}>
          {video.category}
        </span>
      </div>

      {/* Bottom info */}
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent">
        <p className="text-white font-bold text-[14px] font-sans tracking-[0.05em] truncate">
          {video.title}
        </p>
        <div className="flex items-center gap-2 mt-1 text-white/70 text-[12px] font-sans">
          <Eye size={12} />
          <span>{video.views.toLocaleString()} views</span>
        </div>
      </div>
    </Link>
  )
}
