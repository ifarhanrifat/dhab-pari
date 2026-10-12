'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ImageUpload } from '@/components/admin/ImageUpload'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// Phase 1 of the card-based redesign, 2026-10-12. The new homepage has
// a handful of image "slots" with no real backing table of their own --
// everything else (project photos, classifieds photos, video thumbnails)
// already has one and is uploaded from its own existing admin page. This
// is just those few: the public committee-logo circle, and the 4+4
// decorative welfare/mentor card thumbnails. One table (site_card_images,
// migration 642), one list, the same ImageUpload component every other
// upload on this site already uses.
const SLOTS: { key: string; label: string; shape: 'circle' | 'rect' }[] = [
  { key: 'committee_logo', label: 'Committee logo (header circle)', shape: 'circle' },
  { key: 'welfare_1', label: 'Welfare card 1 — Zakat & Ushr', shape: 'rect' },
  { key: 'welfare_2', label: 'Welfare card 2 — Kafalat (School)', shape: 'rect' },
  { key: 'welfare_3', label: 'Welfare card 3 — Taleemi Wazifa', shape: 'rect' },
  { key: 'welfare_4', label: 'Welfare card 4 — Esal-e-Sawab', shape: 'rect' },
  { key: 'mentor_1', label: 'Mentor card 1 — Mentors', shape: 'rect' },
  { key: 'mentor_2', label: 'Mentor card 2 — Institutes', shape: 'rect' },
  { key: 'mentor_3', label: 'Mentor card 3 — Training Programs', shape: 'rect' },
  { key: 'mentor_4', label: 'Mentor card 4 — Talent Showcase', shape: 'rect' },
]

export default function CardImagesPage() {
  const { isUrdu } = useLocale()
  const [images, setImages] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    supabase.from('site_card_images').select('slot_key, image_url').then(({ data }) => {
      setImages(Object.fromEntries((data ?? []).map((r) => [r.slot_key, r.image_url || ''])))
      setLoading(false)
    })
  }, [])

  const save = async (slotKey: string, url: string) => {
    setImages((prev) => ({ ...prev, [slotKey]: url }))
    await supabase.from('site_card_images').upsert({ slot_key: slotKey, image_url: url || null }, { onConflict: 'tenant_id,slot_key' })
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-2">Homepage Images</h1>
      <p className="font-sans text-[14px] text-dp-on-surface-variant mb-6 max-w-2xl">
        Photos for the cards on your public homepage that don&apos;t come from another real record (projects, classifieds and videos already have their own photo upload on their own admin pages — this is just the committee logo and the welfare/mentor card thumbnails).
      </p>
      {loading ? (
        <div className="text-center py-12 text-dp-on-surface-variant">Loading…</div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {SLOTS.map((slot) => (
            <div key={slot.key} className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <ImageUpload
                bucket="images"
                label={slot.label}
                currentUrl={images[slot.key] || undefined}
                onUpload={(url) => save(slot.key, url)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
