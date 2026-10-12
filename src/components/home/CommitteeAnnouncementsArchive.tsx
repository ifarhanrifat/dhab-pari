'use client'

// The full, permanent record of every committee announcement — the
// homepage card only ever shows the latest one plus a short popup archive;
// this is where "date-wise, saved on the committee page" actually lives. A
// vertical timeline (date marker + connector + card) rather than a flat
// list, since date order IS the structure here — each entry needs its own
// date read at a glance, not buried in a paragraph.

import Link from 'next/link'
import { Megaphone, FolderKanban, Link2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ShareButtons } from '@/components/public/ShareButtons'
import { useSite } from '@/components/layout/SiteProvider'
import type { CommitteeNote } from './CommitteeNoteCard'

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function CommitteeAnnouncementsArchive({ notes }: { notes: CommitteeNote[] }) {
  const { t, isUrdu } = useLocale()
  const site = useSite()

  const body = (n: CommitteeNote) => (isUrdu ? (n.body_ur || n.body_en) : (n.body_en || n.body_ur))
  const urduStyle = isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } as const : undefined
  // Same "project first, else the generic link_url/label pair" resolution as
  // the homepage card's LinkFooter — a note is about a project (its own
  // foreign key) or a site feature/custom link (migration 306), never both.
  const linkFor = (n: CommitteeNote) => {
    const isProject = !!n.project_id
    const href = isProject ? `/projects/${n.project_id}` : n.link_url
    const label = isProject ? ((isUrdu && n.project_title_ur) || n.project_title) : ((isUrdu && n.link_label_ur) || n.link_label_en || n.link_label_ur)
    if (!href || !label) return null
    return { href, label, isProject, isExternal: !isProject && /^https?:\/\//.test(href) }
  }

  return (
    <section id="announcements" dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="flex items-center gap-3 mb-8">
        <span className="bg-dp2-primary-dark text-white rounded-full p-2.5 shrink-0"><Megaphone size={20} /></span>
        <h2 className="font-heading text-[29px] md:text-[33px] font-bold leading-[37px] text-dp2-primary">
          {t('home.allAnnouncements')}
        </h2>
      </div>

      {notes.length === 0 ? (
        <div className="bg-white border border-dp2-card-border rounded-2xl text-center py-16 text-slate-500 font-sans">
          {t('home.noCommitteeNotes')}
        </div>
      ) : (
        <div className="relative">
          {/* The connector line — inset from the date column, running the
              full height of the list. Logical inset (start-*) so it sits on
              the correct side under both directions. */}
          <div className="absolute top-2 bottom-2 start-[87px] w-px bg-dp2-card-border hidden sm:block" aria-hidden />
          <div className="space-y-8">
            {notes.map((n) => {
              const link = linkFor(n)
              const absoluteUrl = link ? (link.isExternal ? link.href : (typeof window !== 'undefined' ? `${window.location.origin}${link.href}` : link.href)) : ''
              return (
                <div key={n.id} className="flex gap-5 sm:gap-6">
                  <div className="hidden sm:flex flex-col items-center w-[70px] shrink-0 pt-1">
                    <span className="font-sans text-[13px] font-bold text-dp2-primary text-center leading-tight" dir="ltr">
                      {fmtDate(n.release_date)}
                    </span>
                    <span className="mt-2 w-3 h-3 rounded-full bg-dp2-gold border-4 border-dp2-surface relative z-10" />
                  </div>
                  <div className="flex-1 min-w-0 bg-white border border-dp2-card-border rounded-2xl p-5 hover:border-dp2-primary-dark/50 transition-colors">
                    <div className="flex items-center justify-between gap-2 mb-2 sm:hidden">
                      <span dir="ltr" className="font-sans text-[13px] font-bold text-dp2-primary">{fmtDate(n.release_date)}</span>
                    </div>
                    <p
                      className="font-sans text-[16.5px] leading-relaxed text-slate-800 whitespace-pre-wrap"
                      style={urduStyle}
                    >
                      {body(n)}
                    </p>
                    {link && (
                      <div className="mt-4 pt-4 border-t border-dp2-card-border/70 flex items-center gap-3 flex-wrap">
                        {link.isExternal ? (
                          <a href={link.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[14.5px] font-sans font-semibold text-dp2-primary-dark hover:text-dp2-primary transition-colors">
                            {link.isProject ? <FolderKanban size={15} /> : <Link2 size={15} />} {link.label}
                          </a>
                        ) : (
                          <Link href={link.href} className="inline-flex items-center gap-1.5 text-[14.5px] font-sans font-semibold text-dp2-primary-dark hover:text-dp2-primary transition-colors">
                            {link.isProject ? <FolderKanban size={15} /> : <Link2 size={15} />} {link.label}
                          </Link>
                        )}
                        <div className="ms-auto">
                          <ShareButtons url={absoluteUrl} text={`${link.label} — ${site.fullName}`} compact />
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
