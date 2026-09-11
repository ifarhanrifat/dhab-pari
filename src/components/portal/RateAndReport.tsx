'use client'

// Shared rating + "report a problem" widget for any completed booking
// screen (city-purchase/[id], dispatch/[callId], ...) — one real
// implementation instead of copy-pasting the same star picker and
// complaint form onto every detail page that reaches a terminal state.
// submit_rating/file_complaint (497) resolve the actual party from the
// ref row server-side, so this component only needs to know who the
// CURRENT viewer should be rating/reporting (the other side of the
// same booking), not re-derive it.

import { useEffect, useState } from 'react'
import { Star, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

const COMPLAINT_KINDS = ['wrong_vehicle', 'wrong_driver', 'no_show', 'behaviour', 'payment_pending', 'fake_booking', 'off_platform_solicitation', 'other'] as const

interface Props {
  refType: string
  refId: string
  againstPartyType: 'vehicle' | 'shop' | 'portal_user'
  againstPartyId: string
}

export function RateAndReport({ refType, refId, againstPartyType, againstPartyId }: Props) {
  const { t, isUrdu } = useLocale()
  const supabase = createClient()

  const [myRating, setMyRating] = useState<{ stars: number; comment: string | null } | null | undefined>(undefined)
  const [stars, setStars] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [showComplaint, setShowComplaint] = useState(false)
  const [kind, setKind] = useState<string>('behaviour')
  const [note, setNote] = useState('')
  const [filingComplaint, setFilingComplaint] = useState(false)
  const [complaintFiled, setComplaintFiled] = useState(false)

  useEffect(() => {
    supabase.rpc('my_rating_for', { p_ref_type: refType, p_ref_id: refId }).then(({ data }) => setMyRating(data ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refType, refId])

  const submitRating = async () => {
    if (stars < 1) { toast.error(t('rr.pickStarsError')); return }
    setSubmitting(true)
    const { error } = await supabase.rpc('submit_rating', { p_ref_type: refType, p_ref_id: refId, p_stars: stars, p_comment: comment.trim() || null })
    setSubmitting(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('rr.ratingSubmittedToast'))
    setMyRating({ stars, comment: comment.trim() || null })
  }

  const fileComplaint = async () => {
    if (!note.trim()) { toast.error(t('rr.describeProblemError')); return }
    setFilingComplaint(true)
    const { error } = await supabase.rpc('file_complaint', {
      p_against_party_type: againstPartyType, p_against_party_id: againstPartyId, p_kind: kind, p_note: note.trim(), p_ref_type: refType, p_ref_id: refId,
    })
    setFilingComplaint(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    toast.success(t('rr.complaintFiledToast'))
    setComplaintFiled(true)
    setShowComplaint(false)
  }

  if (myRating === undefined) return null

  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5 mb-4">
      <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface mb-2">{t('rr.howWasItHeading')}</p>

      {myRating ? (
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={16} className={n <= myRating!.stars ? 'fill-current text-amber-500' : 'text-dp-outline-variant'} />)}
          <span className="font-sans text-[12px] text-dp-on-surface-variant ms-1">{t('rr.yourRatingNote')}</span>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" onClick={() => setStars(n)} className="cursor-pointer">
                <Star size={20} className={n <= stars ? 'fill-current text-amber-500' : 'text-dp-outline-variant hover:text-amber-300'} />
              </button>
            ))}
          </div>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('rr.commentPlaceholder')} className="input-field !text-[13px]" />
          <button onClick={submitRating} disabled={submitting || stars < 1} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-secondary text-white hover:bg-dp-primary disabled:opacity-50">
            {submitting ? t('action.saving') : t('rr.submitRatingBtn')}
          </button>
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-dp-outline-variant/60">
        {complaintFiled ? (
          <p className="font-sans text-[12px] text-dp-on-surface-variant flex items-center gap-1"><ShieldAlert size={12} /> {t('rr.complaintFiledNote')}</p>
        ) : !showComplaint ? (
          <button onClick={() => setShowComplaint(true)} className="flex items-center gap-1.5 font-sans text-[12px] font-semibold text-dp-on-surface-variant hover:text-dp-error cursor-pointer">
            <ShieldAlert size={13} /> {t('rr.reportProblemBtn')}
          </button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-sans text-[12.5px] font-semibold text-dp-on-surface">{t('rr.reportProblemBtn')}</p>
              <button onClick={() => setShowComplaint(false)} className="cursor-pointer text-dp-on-surface-variant"><X size={14} /></button>
            </div>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className="input-field !text-[13px]">
              {COMPLAINT_KINDS.map((k) => <option key={k} value={k}>{t(`pc.kind.${k}`)}</option>)}
            </select>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('rr.describeProblemPlaceholder')} className="input-field !text-[13px] resize-none" />
            <button onClick={fileComplaint} disabled={filingComplaint} className="px-3 py-1.5 rounded-lg text-[12.5px] font-sans font-semibold cursor-pointer bg-dp-error text-white hover:opacity-90 disabled:opacity-50">
              {filingComplaint ? t('action.saving') : t('rr.submitComplaintBtn')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
