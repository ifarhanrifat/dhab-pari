'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { ShieldAlert } from 'lucide-react'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// A publisher can point a camera at the whole village on the committee's behalf.
// The rules about that — no video of women, consent before filming, nothing from
// inside anyone's home — are shown once, in both languages, and their acceptance
// is recorded against the version they saw.
//
// Blocking rather than dismissible on purpose: "I never saw that" has to stop
// being a possible answer. Bumping publisher_guidelines_version in Settings
// re-prompts everyone, which is the only way an edited rule reaches the people
// it binds.
export function PublisherGuidelinesGate() {
  const { t } = useLocale()
  const [needed, setNeeded] = useState(false)
  const [version, setVersion] = useState('1')
  const [textEn, setTextEn] = useState('')
  const [textUr, setTextUr] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    ;(async () => {
      const { data: auth } = await supabase.auth.getUser()
      if (!auth.user) return
      const { data: me } = await supabase.from('admin_users')
        .select('role, secondary_role, guidelines_acked_version')
        .eq('auth_user_id', auth.user.id).maybeSingle()
      if (!me) return
      if (me.role !== 'publisher' && me.secondary_role !== 'publisher') return

      const { data: rows } = await supabase.from('site_settings').select('key, value')
        .in('key', ['publisher_guidelines_version', 'publisher_guidelines_en', 'publisher_guidelines_ur'])
      const v = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value ?? '']))
      const current = v.publisher_guidelines_version || '1'
      if (me.guidelines_acked_version === current) return

      setVersion(current)
      setTextEn(v.publisher_guidelines_en || '')
      setTextUr(v.publisher_guidelines_ur || '')
      setNeeded(true)
    })()
  }, [])

  const accept = async () => {
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase.rpc('ack_publisher_guidelines', { p_version: version })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    setNeeded(false)
  }

  if (!needed) return null

  return (
    <div className="fixed inset-0 bg-black/70 z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-dp-outline-variant flex items-start gap-3">
          <ShieldAlert size={24} className="text-dp-primary shrink-0 mt-0.5" />
          <div>
            <h2 className="font-heading text-[20px] font-bold text-dp-primary">{t('y.beforeYouPublish')}</h2>
            <p className="font-sans text-[13px] text-dp-on-surface-variant">Please read these rules. They protect the people of the village, and they protect you.</p>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5 space-y-6">
          {textUr && (
            <div dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }} className="font-sans text-[15px] leading-[2.1] text-dp-on-surface whitespace-pre-line">
              {textUr}
            </div>
          )}
          {textUr && textEn && <div className="border-t border-dashed border-dp-outline-variant" />}
          {textEn && (
            <div className="font-sans text-[14px] leading-[1.75] text-dp-on-surface whitespace-pre-line">{textEn}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-dp-outline-variant">
          <label className="flex items-start gap-2.5 cursor-pointer mb-3">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="accent-dp-secondary mt-0.5 cursor-pointer" />
            <span className="font-sans text-[13.5px] text-dp-on-surface">
              I have read and understood these rules, and I will follow them.
              <span className="block text-dp-on-surface-variant" dir="rtl" style={{ fontFamily: 'var(--font-urdu), serif' }}>
                میں نے یہ اصول پڑھ اور سمجھ لیے ہیں اور ان پر عمل کروں گا۔
              </span>
            </span>
          </label>
          <button
            onClick={accept}
            disabled={!agreed || saving}
            className="w-full bg-dp-secondary text-white py-2.5 rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving...' : 'I agree'}
          </button>
        </div>
      </div>
    </div>
  )
}
