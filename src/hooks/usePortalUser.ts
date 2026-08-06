'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export interface PortalUser {
  id: string
  full_name: string
  name_ur: string | null
  mobile: string
  whatsapp_number: string | null
  father_husband_name: string | null
  donor_type: string | null
  country: string | null
  sector: string | null
  avatar_url: string | null
  username: string | null
  email: string | null
  consumer_id: string | null
  donor_account_id: string | null
}

// Single source of truth for "who is the logged-in portal user" — mirrors
// useSystemAccess's role in the admin panel. consumer_id/donor_account_id
// being null just means that identity hasn't been linked (or established)
// yet; pages gate their own sections on these rather than assuming both.
export function usePortalUser() {
  const [user, setUser] = useState<PortalUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user: authUser } }) => {
      if (!authUser) { setLoading(false); return }
      const { data } = await supabase.from('portal_users')
        .select('id, full_name, name_ur, mobile, whatsapp_number, father_husband_name, donor_type, country, sector, avatar_url, username, email, consumer_id, donor_account_id')
        .eq('auth_user_id', authUser.id).single()
      setUser(data ?? null)
      setLoading(false)
    })
  }, [])

  return { user, loading }
}
