'use client'

// Real ask, 2026-11-04: "when there is a message of rider or driver
// then there should be a red alert on that chat icon." One hook, same
// (threadType, refId) pairs BookingChatPanel/GroupChatPanel already
// take as props — polls chat_has_unread (801) and the mark-as-read
// call happens once inside those panels themselves, the one real place
// "read" actually occurs.

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export type ChatThreadType = 'hourly_booking' | 'rental_booking' | 'equipment_booking' | 'shadi_vehicle_request' | 'trip' | 'adda'

export function useChatUnread(threadType: ChatThreadType, refId: string | null | undefined) {
  const [unread, setUnread] = useState(false)
  useEffect(() => {
    if (!refId) { setUnread(false); return }
    let live = true
    const supabase = createClient()
    const check = () => supabase.rpc('chat_has_unread', { p_thread_type: threadType, p_thread_ref_id: refId }).then(({ data }) => { if (live) setUnread(!!data) })
    check()
    const iv = setInterval(check, 15000)
    return () => { live = false; clearInterval(iv) }
  }, [threadType, refId])
  return unread
}
