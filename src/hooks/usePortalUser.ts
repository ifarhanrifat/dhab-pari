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
  display_name: string | null
  consumer_id: string | null
  donor_account_id: string | null
  donor_link_confirmed_at: string | null
  gender: string | null
  profession: string | null
  profession_other: string | null
  education_level: string | null
  education_details: string | null
  is_currently_studying: boolean | null
  seeking_mentorship: boolean
  is_minor: boolean
  guardian_name: string | null
  guardian_mobile: string | null
  phone_private: boolean
  mentor_type: string | null
  mentor_status: string
  mentor_bio: string | null
  mentor_expertise: string | null
  mentor_available: boolean
}

// Single source of truth for "who is the logged-in portal user" — mirrors
// useSystemAccess's role in the admin panel. consumer_id/donor_account_id
// being null just means that identity hasn't been linked (or established)
// yet; pages gate their own sections on these rather than assuming both.
export function usePortalUser() {
  const [user, setUser] = useState<PortalUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    const supabase = createClient()
    const { data: { user: authUser } } = await supabase.auth.getUser()
    if (!authUser) { setLoading(false); return }
    const { data } = await supabase.from('portal_users')
      .select('id, full_name, name_ur, mobile, whatsapp_number, father_husband_name, donor_type, country, sector, avatar_url, username, email, display_name, consumer_id, donor_account_id, donor_link_confirmed_at, gender, profession, profession_other, education_level, education_details, is_currently_studying, seeking_mentorship, is_minor, guardian_name, guardian_mobile, phone_private, mentor_type, mentor_status, mentor_bio, mentor_expertise, mentor_available')
      .eq('auth_user_id', authUser.id).single()
    setUser(data ?? null)
    setLoading(false)
  }

  // refresh is deliberately excluded from the effect's deps — it's
  // recreated every render (closes over nothing stateful) and including it
  // would just be a lint-satisfying no-op; the mount-only fetch is what's
  // actually wanted here.
  useEffect(() => { refresh() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { user, loading, refresh }
}
