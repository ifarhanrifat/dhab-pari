'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Routes a logged-in portal user straight to the prefilled /portal/donate
// flow (skips re-entering name/father's name/WhatsApp, already known from
// their session); everyone else gets the anonymous /donate/submit form.
export function DonateCTAButton({ className }: { className?: string }) {
  const { t } = useLocale()
  const [href, setHref] = useState('/donate/submit')

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).eq('is_active', true).maybeSingle()
      if (data) setHref('/portal/donate')
    })
  }, [])

  return (
    <Link href={href} className={className}>
      {t('y.submitDonation')}
    </Link>
  )
}
