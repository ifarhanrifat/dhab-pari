'use client'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Generic "don't show this again" mechanism (migration 562) -- any banner
// or helper instruction that should support a permanent dismiss checkbox
// uses this with its own unique hintId, rather than each one inventing its
// own dismissed-flag column. Replaces the old pattern (PushPermissionBanner)
// of re-showing a nudge on every single page load forever with no way out.
export function useDismissedHint(hintId: string, owner: { adminUserId?: string; portalUserId?: string } | null) {
  // null = not loaded yet (don't flash the banner before we know)
  const [dismissed, setDismissed] = useState<boolean | null>(null)

  useEffect(() => {
    if (!owner || (!owner.adminUserId && !owner.portalUserId)) { setDismissed(true); return }
    const supabase = createClient()
    const column = owner.adminUserId ? 'admin_user_id' : 'portal_user_id'
    const id = owner.adminUserId ?? owner.portalUserId
    supabase.from('dismissed_hints').select('id').eq(column, id!).eq('hint_id', hintId).maybeSingle()
      .then(({ data }) => setDismissed(!!data))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hintId, owner?.adminUserId, owner?.portalUserId])

  const dismissForever = useCallback(async () => {
    if (!owner) return
    setDismissed(true)
    const supabase = createClient()
    const { error } = await supabase.from('dismissed_hints').insert({
      admin_user_id: owner.adminUserId ?? null,
      portal_user_id: owner.portalUserId ?? null,
      hint_id: hintId,
    })
    // 23505 = already dismissed from another tab/device in the meantime --
    // harmless, the state here is already correct either way.
    if (error && error.code !== '23505') setDismissed(false)
  }, [hintId, owner])

  return { dismissed, dismissForever }
}
