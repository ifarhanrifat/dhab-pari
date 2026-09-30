'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Siren, Phone, HandHeart, Droplet, HeartCrack, MapPin } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface Contact { id: string; label: string; label_ur: string | null; phone: string; whatsapp_number: string | null; category: string }
interface HelpReq { id: string; category: string; description: string; location_text: string | null; contact_name: string; contact_mobile: string }

const EMERGENCY_CATEGORIES = ['police', 'rescue', 'fire', 'ambulance', 'hospital', 'committee']

// Phase 2 of the "Village OS" feature set, 2026-09-30. Reuses
// important_contacts (Phase 1, migration 528) for the numbers grid --
// no new table needed for that part -- and help_requests (migration 531)
// for the community "Need Help" board.
export default function EmergencyPage() {
  const { t, isUrdu } = useLocale()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [requests, setRequests] = useState<HelpReq[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const supabase = createClient()
    Promise.all([
      supabase.from('important_contacts').select('id, label, label_ur, phone, whatsapp_number, category')
        .eq('is_active', true).in('category', EMERGENCY_CATEGORIES).order('display_order'),
      supabase.from('help_requests').select('id, category, description, location_text, contact_name, contact_mobile')
        .eq('status', 'open').order('created_at', { ascending: false }).limit(30),
    ]).then(([cRes, hRes]) => {
      setContacts(cRes.data ?? [])
      setRequests(hRes.data ?? [])
      setLoading(false)
    })
  }, [])

  return (
    <div className="max-w-[900px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <Siren size={26} className="text-red-600" />
        <h1 className="font-heading text-[28px] font-bold text-red-700">{t('em.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('em.pageIntro')}</p>

      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>
      ) : (
        <>
          {/* Emergency numbers — big, high-contrast, one tap to call.
              Real correction, 2026-09-30: these are all, collectively,
              "the emergency numbers" — a heading per sub-category (police/
              rescue/fire/...) split what used to be one compact grid into
              several one-item sections stacked vertically. Back to a
              single flat grid; fixed order (most urgent first) via
              EMERGENCY_CATEGORIES rather than however the data comes back. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-10">
            {EMERGENCY_CATEGORIES.flatMap((cat) => contacts.filter((c) => c.category === cat)).map((c) => (
              <a key={c.id} href={`tel:${c.phone.replace(/\s+/g, '')}`}
                className="bg-red-600 text-white rounded-lg p-4 flex flex-col items-center text-center gap-1 hover:bg-red-700 transition-all active:scale-95">
                <Phone size={20} />
                <span className="font-sans text-[13px] font-bold">{isUrdu && c.label_ur ? c.label_ur : c.label}</span>
                <span className="font-sans text-[15px] font-bold ltr-num">{c.phone}</span>
              </a>
            ))}
          </div>

          {/* Blood — its own real system, not duplicated here */}
          <Link href="/blood" className="flex items-center justify-between gap-3 bg-white border-2 border-red-200 rounded-lg p-4 mb-4 hover:border-red-400 transition-all">
            <div className="flex items-center gap-3">
              <Droplet size={22} className="text-red-600" />
              <span className="font-sans text-[15px] font-semibold text-dp-on-surface">{t('em.bloodNeeded')}</span>
            </div>
            <span className="text-red-600 font-sans text-[13px] font-bold">{t('em.goToBlood')} →</span>
          </Link>

          <Link href="/death-announcements" className="flex items-center justify-between gap-3 bg-white border-2 border-dp-outline-variant rounded-lg p-4 mb-10 hover:border-dp-secondary transition-all">
            <div className="flex items-center gap-3">
              <HeartCrack size={22} className="text-dp-secondary" />
              <span className="font-sans text-[15px] font-semibold text-dp-on-surface">{t('da.pageTitle')}</span>
            </div>
            <span className="text-dp-secondary font-sans text-[13px] font-bold">→</span>
          </Link>

          {/* Need Help board */}
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <h2 className="font-heading text-[20px] font-bold text-dp-primary flex items-center gap-2"><HandHeart size={20} className="text-dp-secondary" /> {t('em.needHelpTitle')}</h2>
            <Link href="/portal/ask-for-help" className="bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary transition-all">{t('em.askForHelp')}</Link>
          </div>
          <p className="font-sans text-[13.5px] text-dp-on-surface-variant mb-4">{t('em.needHelpIntro')}</p>

          {requests.length === 0 ? (
            <p className="text-center py-10 text-dp-on-surface-variant font-sans text-[14px] bg-white border border-dp-outline-variant rounded-lg">{t('em.noOpenRequests')}</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {requests.map((r) => (
                <div key={r.id} className="bg-white border border-dp-outline-variant rounded-lg p-4">
                  <span className="text-[10.5px] font-bold px-2.5 py-1 rounded-full bg-dp-secondary-container text-dp-on-secondary-container uppercase">{t(`hr.cat.${r.category}`)}</span>
                  <p className="font-sans text-[14px] text-dp-on-surface mt-2">{r.description}</p>
                  {r.location_text && <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1.5 flex items-center gap-1"><MapPin size={12} /> {r.location_text}</p>}
                  <div className="flex gap-2 mt-3">
                    <a href={`tel:${r.contact_mobile}`} className="flex-1 flex items-center justify-center gap-2 border-2 border-dp-primary text-dp-primary px-3 py-2 rounded-lg font-sans text-[13px] font-semibold hover:bg-dp-primary hover:text-white transition-all">
                      <Phone size={13} /> {t('x.call')}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
