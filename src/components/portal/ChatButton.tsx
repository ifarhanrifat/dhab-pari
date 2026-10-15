'use client'

// Opens the auto-created chat thread for a booking (negotiation_threads,
// kind='booking', migration 658) — the real gap the design has that this
// app's hourly/equipment/rental/shadi verticals never wired up: a rider
// and driver could never message each other about one of these jobs.
// basePath picks which side's thread-detail route to land on (same RPCs,
// different chrome/nav either side of the portal).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type RefType = 'hourly_booking' | 'equipment_booking' | 'rental_booking' | 'shadi_vehicle_request'

export function ChatButton({ refType, refId, basePath, className }: { refType: RefType; refId: string; basePath: '/portal/marketplace/negotiations' | '/portal/my-vehicle/chat'; className?: string }) {
  const { t, isUrdu } = useLocale()
  const router = useRouter()
  const supabase = createClient()
  const [loading, setLoading] = useState(false)

  const open = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('booking_thread_id', { p_ref_type: refType, p_ref_id: refId })
    setLoading(false)
    if (error) { toast.error(friendlyError(error, undefined, isUrdu)); return }
    if (!data) { toast.error(t('vp.chatUnavailableHint')); return }
    router.push(`${basePath}/${data}`)
  }

  return (
    <button onClick={open} disabled={loading} className={className ?? 'inline-flex items-center gap-1.5 font-sans text-[12px] font-semibold text-[#166534] cursor-pointer disabled:opacity-50'}>
      {loading ? <Loader2 size={12} className="animate-spin" /> : <MessageCircle size={12} />} {t('vp.chatBtn')}
    </button>
  )
}
