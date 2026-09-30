'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Megaphone, Pin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

// Phase 1 of the "Village OS" feature set, 2026-09-30: "whatever's on the
// physical village notice board is also in the app" — this doesn't add a
// new content type, it's the two that already exist (committee_notes,
// which the homepage's CommitteeNoteCard already reads, and news_posts'
// 'announcement' category) merged into the one page a resident checks
// for "what's official right now", instead of hunting across /news and
// the homepage.
interface NoticeItem {
  id: string; kind: 'note' | 'news'; title: string | null; body: string; date: string
  linkUrl?: string | null; linkLabel?: string | null
}

export default function NoticeBoardPage() {
  const { t, isUrdu } = useLocale()
  const [items, setItems] = useState<NoticeItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('committee_notes')
        .select('id, body_en, body_ur, release_date, link_url, link_label_en, link_label_ur')
        .eq('is_published', true).order('release_date', { ascending: false }).limit(20),
      supabase.from('news_posts')
        .select('id, title, content, published_at')
        .eq('is_published', true).eq('category', 'announcement')
        .order('published_at', { ascending: false }).limit(20),
    ]).then(([notesRes, newsRes]) => {
      const notes: NoticeItem[] = (notesRes.data ?? []).map((n) => ({
        id: `note-${n.id}`, kind: 'note', title: null,
        body: isUrdu ? n.body_ur : n.body_en,
        date: n.release_date,
        linkUrl: n.link_url, linkLabel: isUrdu ? n.link_label_ur : n.link_label_en,
      }))
      const news: NoticeItem[] = (newsRes.data ?? []).map((n) => ({
        id: `news-${n.id}`, kind: 'news', title: n.title, body: n.content, date: n.published_at,
      }))
      setItems([...notes, ...news].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()))
      setLoading(false)
    })
  }, [isUrdu])

  return (
    <div className="max-w-[720px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Megaphone size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('nb.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('nb.pageIntro')}</p>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}

      {!loading && items.length === 0 && (
        <p className="text-center py-16 text-dp-on-surface-variant font-sans text-[15px]">{t('nb.empty')}</p>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-4">
          {items.map((item) => (
            <div key={item.id} className="bg-white border border-dp-outline-variant rounded-lg p-5 relative">
              <div className="flex items-start gap-3">
                <Pin size={16} className="text-dp-secondary shrink-0 mt-1" />
                <div className="min-w-0 flex-1">
                  {item.title && <h3 className="font-sans text-[16px] font-bold text-dp-on-surface mb-1">{item.title}</h3>}
                  <p className="font-sans text-[14px] text-dp-on-surface leading-[22px] whitespace-pre-line">{item.body}</p>
                  <div className="flex items-center justify-between gap-3 mt-3">
                    <p className="font-sans text-[11.5px] text-dp-on-surface-variant">
                      {new Date(item.date).toLocaleDateString(isUrdu ? 'ur-PK-u-nu-latn' : 'en-PK', { day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                    {item.linkUrl && (
                      <Link href={item.linkUrl} className="text-dp-secondary font-sans text-[12.5px] font-semibold hover:underline shrink-0">
                        {item.linkLabel || t('nb.readMore')}
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
