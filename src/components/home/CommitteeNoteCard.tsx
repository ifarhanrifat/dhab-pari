'use client'

// The committee's own voice on the homepage — new projects, decisions,
// anything meant to speak directly to the village. Styled identically to the
// Cash Position card next to it (same dark card, same uppercase kicker, same
// translucent button) so it reads as belonging to the same page, not a
// bolted-on widget. A tiny client island for the same reason T/LocaleDir are:
// the page itself is a cached Server Component, so which language shows
// (and which note text — body_en vs body_ur, real DB content, not a
// dictionary key) can only be decided in the browser.

import { useState } from 'react'
import { X, Megaphone } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

export interface CommitteeNote { id: string; body_en: string; body_ur: string; release_date: string }

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

  return (
    <>
      <div className="bg-dp-primary text-white rounded-lg p-6 border border-dp-primary-container">
        <h3 className="text-[13px] font-sans font-semibold tracking-[0.05em] uppercase opacity-80 mb-3">
          {t('home.committeeRelease')}<span dir="ltr">{fmtDate(latest.release_date)}</span>
        </h3>
        <p className="text-[13px] font-sans font-extrabold uppercase tracking-wide opacity-90 mb-2">{t('home.announcement')}</p>
        <p
          className="text-[14px] font-sans leading-relaxed opacity-95 mb-4"
          dir={isUrdu ? 'rtl' : 'ltr'}
          style={{ ...urduStyle, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
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

      {open && (
        <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-white rounded-lg w-full max-w-lg max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
            dir={isUrdu ? 'rtl' : 'ltr'}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-dp-outline-variant sticky top-0 bg-white">
              <h2 className="font-heading text-[19px] font-bold text-dp-primary flex items-center gap-2">
                <Megaphone size={19} className="text-dp-secondary shrink-0" /> {t('home.announcement')}
              </h2>
              <button onClick={() => setOpen(false)} className="cursor-pointer text-dp-on-surface-variant shrink-0"><X size={20} /></button>
            </div>
            <div className="p-5 space-y-6">
              <div>
                <p dir="ltr" className="text-[12px] font-sans font-semibold text-dp-on-surface-variant uppercase tracking-wide mb-1.5">{fmtDate(latest.release_date)}</p>
                <p className="text-[15px] font-sans leading-relaxed text-dp-on-surface whitespace-pre-wrap" style={urduStyle}>
                  {body(latest)}
                </p>
              </div>
              {archive.length > 0 && (
                <div className="pt-5 border-t border-dp-outline-variant space-y-4">
                  <p className="text-[12px] font-sans font-bold text-dp-on-surface-variant uppercase tracking-wide">{t('home.committeeNotesArchive')}</p>
                  {archive.map((n) => (
                    <div key={n.id}>
                      <p dir="ltr" className="text-[11px] font-sans font-semibold text-dp-on-surface-variant mb-0.5">{fmtDate(n.release_date)}</p>
                      <p className="text-[13.5px] font-sans text-dp-on-surface-variant leading-relaxed whitespace-pre-wrap" style={urduStyle}>
                        {body(n)}
                      </p>
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
