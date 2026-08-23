'use client'

// The committee's own voice on the homepage — new projects, decisions,
// anything meant to speak directly to the village. Same dark card family as
// Cash Position next to it (so it still reads as belonging to the page), but
// given its own identity on top of that shared language: a badge-style
// heading instead of a bare uppercase label, and the same corner-glow depth
// the Vision panel on /about already uses, rather than a second flat block
// sitting next to Cash Position's flat block. A tiny client island for the
// same reason T/LocaleDir are: the page itself is a cached Server Component,
// so which language shows (and which note text — body_en vs body_ur, real DB
// content, not a dictionary key) can only be decided in the browser.

import { useState } from 'react'
import Link from 'next/link'
import { X, Megaphone, FolderKanban, Link2 } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { ShareButtons } from '@/components/public/ShareButtons'
import { SITE } from '@/lib/constants'

export interface CommitteeNote {
  id: string
  body_en: string
  body_ur: string
  release_date: string
  // A project (its own foreign key, resolved from the live record) or a
  // plain link_url/label pair (a site feature — Kafalat, Zakat, ... — or a
  // fully custom link, see migration 306 and siteFeatureLinks.ts). At most
  // one of the two is ever set; project takes precedence if somehow both are.
  project_id: string | null
  project_title: string | null
  project_title_ur: string | null
  link_url: string | null
  link_label_en: string | null
  link_label_ur: string | null
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function CommitteeNoteCard({ latest, archive }: { latest: CommitteeNote | null; archive: CommitteeNote[] }) {
  const { t, isUrdu } = useLocale()
  const [open, setOpen] = useState(false)

  // Nothing posted yet — no empty card on the homepage.
  if (!latest) return null

  const body = (n: CommitteeNote) => (isUrdu ? (n.body_ur || n.body_en) : (n.body_en || n.body_ur))
  const urduStyle = isUrdu ? { fontFamily: 'var(--font-urdu), serif' } as const : undefined

  // A note's own related link (a project, or a site feature/custom URL) plus
  // a way to actually pass it on — this is what "share this announcement"
  // means when it's about something real: that thing's own page, not the
  // note text on its own.
  const LinkFooter = ({ n }: { n: CommitteeNote }) => {
    const isProject = !!n.project_id
    const href = isProject ? `/projects/${n.project_id}` : n.link_url
    const label = isProject ? ((isUrdu && n.project_title_ur) || n.project_title) : ((isUrdu && n.link_label_ur) || n.link_label_en || n.link_label_ur)
    if (!href || !label) return null
    const isExternal = !isProject && /^https?:\/\//.test(href)
    const absoluteUrl = isExternal ? href : (typeof window !== 'undefined' ? `${window.location.origin}${href}` : href)
    return (
      <div className="mt-3 pt-3 border-t border-dp-outline-variant/70 flex items-center gap-2 flex-wrap">
        {isExternal ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-sans font-semibold text-dp-secondary hover:text-dp-primary transition-colors">
            {isProject ? <FolderKanban size={14} /> : <Link2 size={14} />} {label}
          </a>
        ) : (
          <Link href={href} className="inline-flex items-center gap-1.5 text-[13px] font-sans font-semibold text-dp-secondary hover:text-dp-primary transition-colors">
            {isProject ? <FolderKanban size={14} /> : <Link2 size={14} />} {label}
          </Link>
        )}
        <div className="ms-auto">
          <ShareButtons url={absoluteUrl} text={`${label} — ${SITE.fullName}`} compact />
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="relative bg-gradient-to-br from-dp-primary to-[#0e3d33] text-white rounded-lg p-6 border border-dp-primary-container overflow-hidden">
        {/* Same corner-glow depth the Vision panel on /about uses — keeps the
            card from reading as a flatter, second-rate copy of Cash Position. */}
        <div className="absolute -top-10 -end-10 w-36 h-36 bg-white/5 rounded-full blur-2xl pointer-events-none" />
        <div className="relative">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="inline-flex items-center gap-1.5 bg-white/15 rounded-full ps-2 pe-3 py-1">
              <span className="bg-white/20 rounded-full p-1"><Megaphone size={12} /></span>
              <span className="text-[12px] font-sans font-extrabold uppercase tracking-wide whitespace-nowrap">{t('home.committeeAnnouncement')}</span>
            </div>
            <span dir="ltr" className="text-[12px] font-sans font-semibold opacity-75 whitespace-nowrap shrink-0">{fmtDate(latest.release_date)}</span>
          </div>
          <p
            className="text-[14.5px] font-sans leading-relaxed opacity-95 mb-4"
            dir={isUrdu ? 'rtl' : 'ltr'}
            style={{ ...urduStyle, display: '-webkit-box', WebkitLineClamp: 9, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {body(latest)}
          </p>
          <button
            onClick={() => setOpen(true)}
            className="block w-full py-2 bg-white/10 hover:bg-white/20 rounded text-center font-bold text-[14px] font-sans tracking-[0.05em] transition-colors cursor-pointer"
          >
            {t('home.readFull')}
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-white rounded-lg w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            dir={isUrdu ? 'rtl' : 'ltr'}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant sticky top-0 bg-white">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary flex items-center gap-2">
                <span className="bg-dp-secondary-container text-dp-secondary rounded-full p-1.5"><Megaphone size={16} /></span>
                {t('home.announcement')}
              </h2>
              <button onClick={() => setOpen(false)} className="cursor-pointer text-dp-on-surface-variant shrink-0"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-6">
              <div>
                <p dir="ltr" className="text-[12px] font-sans font-semibold text-dp-on-surface-variant uppercase tracking-wide mb-1.5">{fmtDate(latest.release_date)}</p>
                <p className="text-[15px] font-sans leading-relaxed text-dp-on-surface whitespace-pre-wrap" style={urduStyle}>
                  {body(latest)}
                </p>
                <LinkFooter n={latest} />
              </div>
              {archive.length > 0 && (
                <div className="pt-5 border-t border-dp-outline-variant space-y-5">
                  <p className="text-[12px] font-sans font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('home.committeeNotesArchive')}</p>
                  {archive.map((n) => (
                    <div key={n.id}>
                      <p dir="ltr" className="text-[11px] font-sans font-semibold text-dp-on-surface-variant mb-0.5">{fmtDate(n.release_date)}</p>
                      <p className="text-[13.5px] font-sans text-dp-on-surface-variant leading-relaxed whitespace-pre-wrap" style={urduStyle}>
                        {body(n)}
                      </p>
                      <LinkFooter n={n} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
