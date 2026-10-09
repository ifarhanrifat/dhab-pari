'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Phone, MessageCircle, PhoneCall } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

// Phase 1 of the "Village OS" feature set, 2026-09-30: one tap to call
// police/rescue/fire/ambulance and local utility/village contacts —
// admin-managed (important_contacts, migration 528) so the committee can
// add or change a number without a deploy.
interface Contact {
  id: string; label: string; label_ur: string | null; phone: string; whatsapp_number: string | null; category: string
}

const categoryColors: Record<string, string> = {
  police: 'bg-blue-600', rescue: 'bg-red-600', fire: 'bg-orange-600', ambulance: 'bg-rose-600',
  hospital: 'bg-emerald-600', electricity: 'bg-amber-500', gas: 'bg-amber-700', water: 'bg-sky-600',
  union_council: 'bg-dp-primary-container', village_rep: 'bg-dp-secondary', committee: 'bg-teal-600', other: 'bg-slate-500',
}
// Real ask, 2026-09-30: grouped by category with a heading per section,
// not one flat list — fixed order (most urgent first) rather than
// whatever order categories happen to appear in the data.
const CATEGORY_ORDER = ['police', 'rescue', 'fire', 'ambulance', 'hospital', 'electricity', 'gas', 'water', 'union_council', 'village_rep', 'committee', 'other']

export default function ContactsPage() {
  const { t, isUrdu } = useLocale()
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    createClient().from('important_contacts').select('id, label, label_ur, phone, whatsapp_number, category')
      .eq('is_active', true).order('display_order').order('created_at')
      .then(({ data }) => { setContacts(data ?? []); setLoading(false) })
  }, [])

  return (
    <div className="max-w-[800px] mx-auto px-6 md:px-12 py-10" dir={isUrdu ? 'rtl' : 'ltr'} style={isUrdu ? { fontFamily: 'var(--font-urdu-ui)' } : undefined}>
      <div className="flex items-center gap-2.5 mb-1.5">
        <PhoneCall size={24} className="text-dp-secondary" />
        <h1 className="font-heading text-[28px] font-bold text-dp-primary">{t('ic.pageTitle')}</h1>
      </div>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-8">{t('ic.pageSubtitle')}</p>

      {loading && <div className="text-center py-12 text-dp-on-surface-variant"><LoadingDots /></div>}

      {!loading && CATEGORY_ORDER.filter((cat) => contacts.some((c) => c.category === cat)).map((cat) => (
        <div key={cat} className="mb-8">
          <h2 className="font-sans text-[13px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-3">{t(`ic.cat.${cat}`)}</h2>
          {/* Real report, 2026-10-09: on a phone (every viewport below
              `sm`), this was one grid column -- i.e. a plain vertical list
              -- and each row's p-4 padding + 44px icon + two 44px action
              buttons made every single contact's row read as oddly tall
              for what's just a name and a phone number, especially for a
              newer tenant with only one or two contacts per category.
              Tightened padding/icon/button sizing closes that up without
              touching the sm:grid-cols-2 desktop layout at all. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-4">
            {contacts.filter((c) => c.category === cat).map((c) => (
              <div key={c.id} className="bg-white border border-dp-outline-variant rounded-lg p-3 flex items-center gap-2.5">
                <span className={`w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0 ${categoryColors[c.category] ?? 'bg-dp-primary'}`}>
                  <Phone size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-sans text-[14px] font-bold text-dp-on-surface truncate">{isUrdu && c.label_ur ? c.label_ur : c.label}</p>
                  <p className="font-sans text-[12.5px] text-dp-on-surface-variant ltr-num">{c.phone}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <a href={`tel:${c.phone.replace(/\s+/g, '')}`} className="p-2 bg-dp-secondary text-white rounded-lg hover:bg-dp-primary transition-all" aria-label={t('ic.call')}>
                    <Phone size={14} />
                  </a>
                  {c.whatsapp_number && (
                    <a href={`https://wa.me/${c.whatsapp_number.replace(/\D/g, '')}`} target="_blank" rel="noopener noreferrer"
                      className="p-2 bg-[#25D366] text-white rounded-lg hover:bg-[#1ebe5a] transition-all" aria-label={t('ic.whatsappBtn')}>
                      <MessageCircle size={14} />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!loading && contacts.length === 0 && (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans text-[14px]">{t('ic.empty')}</p>
      )}
    </div>
  )
}
