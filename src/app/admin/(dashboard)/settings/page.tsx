'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Save } from 'lucide-react'
import { toast, Toaster } from 'sonner'

interface Setting { id: string; key: string; value: string | null; description: string | null }

const settingGroups = [
  { label: 'WhatsApp', keys: ['whatsapp_number', 'whatsapp_link'] },
  { label: 'JazzCash', keys: ['jazzcash_number', 'jazzcash_name'] },
  { label: 'Easypaisa', keys: ['easypaisa_number', 'easypaisa_name'] },
  { label: 'Bank Details', keys: ['bank_name', 'bank_account', 'bank_branch'] },
  { label: 'Office', keys: ['office_hours'] },
  { label: 'About', keys: ['about_text', 'vision', 'mission'] },
]

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Setting[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const supabase = createClient()

  useEffect(() => {
    supabase.from('site_settings').select('*').order('key').then(({ data }) => {
      const s = data ?? []
      setSettings(s)
      const v: Record<string, string> = {}
      s.forEach((setting) => { v[setting.key] = setting.value ?? '' })
      setValues(v)
      setLoading(false)
    })
  }, [])

  const saveAll = async () => {
    setSaving(true)
    const updates = Object.entries(values).map(([key, value]) =>
      supabase.from('site_settings').update({ value, updated_at: new Date().toISOString() }).eq('key', key)
    )
    await Promise.all(updates)
    toast.success('Settings saved')
    setSaving(false)
  }

  if (loading) return <div className="text-center py-12 text-dp-on-surface-variant">Loading settings...</div>

  return (
    <>
      <Toaster position="top-right" />
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary">Site Settings</h1>
        <button onClick={saveAll} disabled={saving} className="flex items-center gap-2 px-6 py-2 bg-dp-secondary text-white rounded-lg font-sans text-[14px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          <Save size={16} /> {saving ? 'Saving...' : 'Save All'}
        </button>
      </div>

      <div className="space-y-8">
        {settingGroups.map((group) => (
          <div key={group.label} className="bg-white border border-dp-outline-variant rounded-lg p-6">
            <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary mb-4 border-b border-dp-outline-variant pb-3">
              {group.label}
            </h2>
            <div className="space-y-4">
              {group.keys.map((key) => {
                const setting = settings.find((s) => s.key === key)
                const isLong = ['about_text', 'vision', 'mission'].includes(key)
                return (
                  <div key={key}>
                    <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                      {key.replace(/_/g, ' ').toUpperCase()}
                      {setting?.description && <span className="font-normal text-[12px] ml-2 opacity-70">— {setting.description}</span>}
                    </label>
                    {isLong ? (
                      <textarea
                        value={values[key] ?? ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                        rows={3}
                        className="input-field resize-none"
                      />
                    ) : (
                      <input
                        type="text"
                        value={values[key] ?? ''}
                        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                        className="input-field"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
