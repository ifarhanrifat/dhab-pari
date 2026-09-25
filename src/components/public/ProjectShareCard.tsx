'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Share2, X, Copy, MessageCircle, Vote } from 'lucide-react'
import { toast } from 'sonner'
import { SITE } from '@/lib/constants'

// Real ask, 2026-09-25: the plain wa.me-only share on project cards (and the
// project detail page's own copy of the same logic) looked nothing like the
// polished WhatsApp/Facebook/Copy-link modal already shipped for committee
// announcements (ShareButtons.tsx) -- and unlike that one, a project share
// has a real photo worth showing off. This is that same idea taken further:
// a preview card with the project's own image (never a real patient photo --
// callers pass the health-category placeholder same as the card itself
// does), plus a professionally-worded Urdu voting appeal when the project is
// still open for votes. Kept as its own component rather than extending
// ShareButtons — that one is used in non-project contexts with no image and
// no voting concept, and forcing both shapes into one prop surface would
// make every caller worse to read.
export function ProjectShareCard({
  projectId, title, imageUrl, isVotingOpen, isUrdu, variant = 'icon', label, className,
}: {
  projectId: string
  title: string
  imageUrl?: string | null
  isVotingOpen?: boolean
  isUrdu: boolean
  // 'icon' — bare icon button (fits an existing icon row, e.g. beside a
  // comment count). 'button' — full button with a visible label, for a card
  // that wants Share to read as its own action rather than a utility icon.
  variant?: 'icon' | 'button'
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const url = typeof window !== 'undefined' ? `${window.location.origin}/projects/${projectId}` : ''

  // Professional, committee-appropriate wording — an appeal for support, not
  // a bare command. Kept short enough to read in full inside a WhatsApp
  // message preview.
  const votingTextUr = `براہِ کرم "${title}" کے حق میں ووٹ دے کر ہماری کمیونٹی کے اس منصوبے کی منظوری میں تعاون فرمائیں۔`
  const votingTextEn = `Please support the approval of "${title}" by casting your vote — every vote helps this community project move forward.`
  const generalTextUr = `"${title}" ملاحظہ کریں — ${SITE.fullNameUrdu}`
  const generalTextEn = `Check out "${title}" — ${SITE.fullName}`

  const shareText = isVotingOpen ? (isUrdu ? votingTextUr : votingTextEn) : (isUrdu ? generalTextUr : generalTextEn)
  const fullMessage = `${shareText}\n${url}`

  const copyLink = async () => {
    await navigator.clipboard.writeText(url)
    toast.success(isUrdu ? 'لنک کاپی ہو گیا' : 'Link copied')
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true) }}
        title={isUrdu ? 'شیئر کریں' : 'Share'}
        className={className ?? (
          variant === 'button'
            ? 'flex items-center gap-1.5 px-4 py-2 border-2 border-dp-outline-variant text-dp-on-surface-variant font-sans text-[13.5px] font-semibold rounded-lg hover:border-dp-secondary hover:text-dp-secondary transition-colors cursor-pointer'
            : 'flex items-center gap-1.5 text-dp-on-surface-variant font-sans text-[13px] hover:text-dp-secondary transition-colors cursor-pointer'
        )}
      >
        <Share2 size={variant === 'button' ? 15 : 15} />
        {label ?? (variant === 'button' ? (isUrdu ? 'شیئر کریں' : 'Share') : null)}
      </button>

      {open && (
        <div className="fixed inset-0 bg-black/60 z-[200] flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl overflow-hidden w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
            {/* Preview card — this is what makes it read as a real "share
                card" instead of a bare action-sheet: the recipient's first
                impression on WhatsApp/Facebook is the actual project photo
                and title, not a plain link. */}
            <div className="relative aspect-[1.91/1] bg-gradient-to-br from-dp-primary to-dp-primary-container">
              {imageUrl && <Image src={imageUrl} alt={title} fill sizes="384px" className="object-cover" />}
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
              {isVotingOpen && (
                <span className="absolute top-3 start-3 flex items-center gap-1 bg-blue-600 text-white text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full">
                  <Vote size={12} /> {isUrdu ? 'ووٹنگ جاری ہے' : 'Voting Open'}
                </span>
              )}
              <button
                type="button" onClick={() => setOpen(false)}
                title={isUrdu ? 'بند کریں' : 'Close'}
                className="absolute top-3 end-3 w-7 h-7 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors cursor-pointer"
              >
                <X size={15} />
              </button>
              <div className="absolute bottom-0 inset-x-0 p-4">
                <p className="text-white font-heading text-[17px] font-bold leading-snug line-clamp-2">{title}</p>
                <p className="text-white/70 font-sans text-[11.5px] mt-0.5">{isUrdu ? SITE.fullNameUrdu : SITE.fullName}</p>
              </div>
            </div>

            <div className="p-5">
              {isVotingOpen && (
                <p dir="rtl" className="font-sans text-[13.5px] leading-[26px] text-dp-on-surface mb-4 text-end" style={{ fontFamily: 'var(--font-urdu-ui)' }}>
                  {votingTextUr}
                </p>
              )}
              <div className="space-y-2.5">
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(fullMessage)}`} target="_blank" rel="noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-[#25D366] text-white py-3 rounded-lg font-sans text-[14px] font-bold hover:opacity-90 transition-all"
                >
                  <MessageCircle size={17} /> WhatsApp
                </a>
                <a
                  href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer"
                  className="w-full flex items-center justify-center gap-2 bg-[#1877F2] text-white py-3 rounded-lg font-sans text-[14px] font-bold hover:opacity-90 transition-all"
                >
                  <span className="font-heading text-[16px] font-black leading-none">f</span> Facebook
                </a>
                <button
                  type="button" onClick={copyLink}
                  className="w-full flex items-center justify-center gap-2 border border-dp-outline-variant text-dp-on-surface py-3 rounded-lg font-sans text-[14px] font-semibold hover:border-dp-secondary transition-all cursor-pointer"
                >
                  <Copy size={16} /> {isUrdu ? 'لنک کاپی کریں' : 'Copy link'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
