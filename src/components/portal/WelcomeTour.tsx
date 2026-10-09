'use client'

import { useEffect, useState } from 'react'
import { Compass, X, Menu, HandCoins, Heart, FileClock, BellRing } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePushNotifications } from '@/hooks/usePushNotifications'
import { useSite } from '@/components/layout/SiteProvider'

const STORAGE_KEY = 'dp-portal-welcome-tour-seen'

// A one-time orientation for a brand new portal account — separate from
// PortalHelp (which is per-page and re-openable via its own icon). This
// one is app-wide: "where is everything, what does this whole app do",
// shown once automatically on whichever page a new user first lands on
// (mounted in the dashboard layout, not a specific page), never shown
// again after being closed once.
//
// Real ask, 2026-10-02: "its just one time allow access... same thing
// which many apps are using [for] camera/contacts/notifications" — rather
// than a separate permission-priming screen, the notification ask now
// rides along inside this same one-time tour, the same way a lot of apps
// bundle their permission asks into first-run onboarding.
export function WelcomeTour() {
  const site = useSite()
  const [open, setOpen] = useState(false)
  const [portalUserId, setPortalUserId] = useState<string | null>(null)
  const { permission, subscribe, subscribing } = usePushNotifications(portalUserId ? { portalUserId } : null)

  useEffect(() => {
    if (!window.localStorage.getItem(STORAGE_KEY)) setOpen(true)
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await supabase.from('portal_users').select('id').eq('auth_user_id', user.id).single()
      if (data) setPortalUserId(data.id)
    })
  }, [])

  const close = () => {
    window.localStorage.setItem(STORAGE_KEY, '1')
    setOpen(false)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/60 z-[210] flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={close}>
      <div
        dir="rtl"
        style={{ fontFamily: 'var(--font-urdu-ui)' }}
        className="bg-white w-full sm:max-w-[600px] sm:rounded-lg rounded-t-2xl max-h-[88vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-dp-primary text-white px-6 py-5 sm:rounded-t-lg flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Compass size={22} />
            <h2 className="font-heading text-[20px] font-bold">{site.nameUrdu || site.name} پورٹل میں خوش آمدید</h2>
          </div>
          <button onClick={close} aria-label="بند کریں" className="text-white/80 hover:text-white cursor-pointer p-1 shrink-0">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 text-[14.5px] leading-[27px] text-dp-on-surface">
          <p>یہ آپ کا ذاتی پورٹل ہے — یہاں سے آپ عطیہ دے سکتے، اپنا پانی کا بل ادا کر سکتے، کفالت/وظیفہ/زکوٰۃ میں حصہ ڈال سکتے، شکایت درج کروا سکتے، اور اپنا مکمل ریکارڈ دیکھ سکتے ہیں۔</p>

          <div className="flex gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0"><Menu size={17} /></span>
            <p><strong className="text-dp-primary">مینیو کہاں ہے؟</strong> موبائل پر اوپر بائیں کونے کا ☰ آئیکن دبائیں — پورا مینیو کھل جائے گا۔ کمپیوٹر پر یہ مینیو ہمیشہ بائیں طرف نظر آتا ہے۔</p>
          </div>

          <div className="flex gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0"><HandCoins size={17} /></span>
            <p><strong className="text-dp-primary">عطیہ کیسے دیں؟</strong> مینیو میں "عطیہ" پر جائیں — کسی منصوبے کے لیے یا جنرل فنڈ میں رقم دے سکتے ہیں۔ ادائیگی کے بعد رسید کی تصویر اپ لوڈ کرنا ضروری ہے۔</p>
          </div>

          <div className="flex gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0"><FileClock size={17} /></span>
            <p>
              <strong className="text-dp-primary">"اعلان شدہ" اور "تصدیق شدہ" میں فرق:</strong> جب آپ عطیہ جمع کرواتے ہیں تو وہ پہلے <strong>اعلان شدہ</strong> ہوتا ہے — یعنی آپ نے بتا دیا۔ جب کمیٹی آپ کی رسید چیک کر لے تو وہ <strong>تصدیق شدہ</strong> بن جاتا ہے۔ اپنا "اعلان شدہ" (ابھی ادا نہ کیا ہوا) وعدہ کہیں بھی نظر آئے تو اس پر کلک کر کے ادائیگی مکمل کریں۔
            </p>
          </div>

          <div className="flex gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-dp-secondary-container text-dp-on-secondary-container shrink-0"><Heart size={17} /></span>
            <p>ہر صفحے کے اوپر ایک چھوٹا <strong className="text-dp-primary">(؟)</strong> آئیکن نظر آئے گا — اس پر کلک کریں تو وہ خاص صفحہ کس کام کا ہے، اور اس کے بٹن کیا کرتے ہیں، تفصیل سے اردو میں سمجھایا جائے گا۔</p>
          </div>

          {permission !== 'granted' && permission !== 'unsupported' && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-amber-100 text-amber-700 shrink-0"><BellRing size={17} /></span>
              <div className="flex-1">
                <p className="font-semibold text-dp-primary mb-1">اطلاعات آن کریں؟</p>
                <p className="text-[13.5px] leading-[24px] mb-3">ایمرجنسی، خون کی اپیلز، اور بل کی یاد دہانی کے لیے فوری اطلاع حاصل کریں — ایپ بند ہونے پر بھی۔</p>
                <button
                  onClick={subscribe}
                  disabled={subscribing || !portalUserId}
                  className="bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50"
                >
                  {subscribing ? '...' : 'اطلاعات آن کریں'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 pt-1">
          <button onClick={close} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans text-[14.5px] font-semibold cursor-pointer hover:bg-dp-primary transition-colors">
            ٹھیک ہے، شروع کرتے ہیں
          </button>
        </div>
      </div>
    </div>
  )
}
