'use client'

// The full, permanent record of every committee announcement — the
// homepage card only ever shows the latest one plus a short popup archive;
// this is where "date-wise, saved on the committee page" actually lives. A
// vertical timeline (date marker + connector + card) rather than a flat
// list, since date order IS the structure here — each entry needs its own
// date read at a glance, not buried in a paragraph.

import Link from 'next/link'
import { Megaphone, FolderKanban } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ShareButtons } from '@/components/public/ShareButtons'
import { SITE } from '@/lib/constants'
import type { CommitteeNote } from './CommitteeNoteCard'

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function CommitteeAnnouncementsArchive({ notes }: { notes: CommitteeNote[] }) {
  const { t, isUrdu } = useLocale()

  const body = (n: CommitteeNote) => (isUrdu ? (n.body_ur || n.body_en) : (n.body_en || n.body_ur))
  const projectTitle = (n: CommitteeNote) => n.project_id ? ((isUrdu && n.project_title_ur) || n.project_title) : null
  const urduStyle = isUrdu ? { fontFamily: 'var(--font-urdu), serif' } as const : undefined

  return (
    <section id="announcements" dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-3 mb-8">
        <span className="bg-dp-primary text-white rounded-full p-2.5 shrink-0"><Megaphone size={20} /></span>
        <h2 className="font-heading text-[28px] md:text-[32px] font-bold leading-[36px] text-dp-primary">
          {t('home.allAnnouncements')}
        </h2>
      </div>

      {notes.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg text-center py-16 text-dp-on-surface-variant font-sans">
          {t('home.noCommitteeNotes')}
        </div>
      ) : (
        <div className="relative">
          {/* The connector line — inset from the date column, running the
              full height of the list. Logical inset (start-*) so it sits on
              the correct side under both directions. */}
          <div className="absolute top-2 bottom-2 start-[87px] w-px bg-dp-outline-variant hidden sm:block" aria-hidden />
          <div className="space-y-8">
            {notes.map((n) => {
              const title = projectTitle(n)
              const url = typeof window !== 'undefined' ? `${window.location.origin}/projects/${n.project_id}` : `/projects/${n.project_id}`
              return (
                <div key={n.id} className="flex gap-5 sm:gap-6">
                  <div className="hidden sm:flex flex-col items-center w-[70px] shrink-0 pt-1">
                    <span className="font-sans text-[12px] font-bold text-dp-primary text-center leading-tight" dir="ltr">
                      {fmtDate(n.release_date)}
                    </span>
                    <span className="mt-2 w-3 h-3 rounded-full bg-dp-secondary border-4 border-dp-secondary-container relative z-10" />
                  </div>
                  <div className="flex-1 min-w-0 bg-white border border-dp-outline-variant rounded-lg p-5 hover:border-dp-secondary/50 transition-colors">
                    <div className="flex items-center justify-between gap-2 mb-2 sm:hidden">
                      <span dir="ltr" className="font-sans text-[12px] font-bold text-dp-primary">{fmtDate(n.release_date)}</span>
                    </div>
                    <p
                      className="font-sans text-[15.5px] leading-relaxed text-dp-on-surface whitespace-pre-wrap"
                      style={urduStyle}
                    >
                      {body(n)}
                    </p>
                    {title && n.project_id && (
                      <div className="mt-4 pt-4 border-t border-dp-outline-variant/70 flex items-center gap-3 flex-wrap">
                        <Link
                          href={`/projects/${n.project_id}`}
                          className="inline-flex items-center gap-1.5 text-[13.5px] font-sans font-semibold text-dp-secondary hover:text-dp-primary transition-colors"
                        >
                          <FolderKanban size={15} /> {title}
                        </Link>
                        <div className="ms-auto">
                          <ShareButtons url={url} text={`${title} — ${SITE.fullName}`} compact />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
