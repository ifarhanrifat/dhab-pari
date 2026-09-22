'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { friendlyError } from '@/lib/errors'
import { useLocale } from '@/lib/i18n/LocaleProvider'

// A real gap, not just two separate bugs: there was no way to create a
// donor account without also recording a donation (rizwan: "the new
// account should be separate function and has nothing to do with
// transaction"). ensure_donor_account() has always existed as a
// standalone building block (migration 007) -- the only callers were a
// donation-insert trigger and assign_donor_numbers, both only ever
// invoked right after a donation. create_donor_account() (migration 502)
// is the first path that creates just the account, no donation row at
// all -- this modal is its only caller. Once created, the donor is
// selectable from the existing donation-receiving picker on the
// transactions page, same as any donor who already has a real donation
// behind them -- recording their first gift is a separate, later step.
export interface CreatedDonor {
  donorKey: string; accountNo: string | null
  name: string; nameUr: string; phone: string; donorType: string; donorLocation: string
}

interface AddDonorModalProps {
  onClose: () => void
  onCreated: (donor: CreatedDonor) => void
}

const empty = { name: '', name_ur: '', phone: '', whatsapp_number: '', father_husband_name: '', donor_type: 'villager', donor_location: '' }

export function AddDonorModal({ onClose, onCreated }: AddDonorModalProps) {
  const { t } = useLocale()
  const supabase = createClient()
  const [form, setForm] = useState(empty)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!form.name.trim()) { toast.error(t('dn.nameRequired')); return }
    setSaving(true)
    const { data, error } = await supabase.rpc('create_donor_account', {
      p_name: form.name, p_name_ur: form.name_ur || null, p_phone: form.phone || null,
      p_whatsapp_number: form.whatsapp_number || null, p_donor_type: form.donor_type,
      p_donor_location: form.donor_location || null, p_father_husband_name: form.father_husband_name || null,
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    const result = data as { account_id: string; donor_key: string; donor_account_no: string | null; duplicate_warning: string | null }
    if (result.duplicate_warning) toast.warning(result.duplicate_warning)
    toast.success(result.donor_account_no ? `${t('dn.donorAccountCreated')} ${result.donor_account_no}` : t('dn.donorAccountCreated'))
    onCreated({
      donorKey: result.donor_key, accountNo: result.donor_account_no,
      name: form.name, nameUr: form.name_ur, phone: form.phone, donorType: form.donor_type, donorLocation: form.donor_location,
    })
    setForm(empty)
  }

  return (
    // p-4 + items-start (not items-center) on the backdrop, and the card's
    // own max-h-[calc(100vh-2rem)]/overflow-y-auto, are what the donors
    // page's old add-donor modal was missing: on a phone keyboard-open
    // view, a vertically-centred, non-scrolling card taller than the
    // visible viewport put its own title bar (top) and Save button
    // (bottom) both off-screen with no way to reach either -- exactly the
    // report ("top part and bottom part not working"). The edit modal two
    // doors down in this same file already had max-h-[92vh]
    // overflow-y-auto; this one just never got it.
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-lg p-6 w-full max-w-lg my-4 sm:my-0 max-h-[calc(100vh-2rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('dn.addDonor')}</h2>
            <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-0.5">{t('dn.addDonorHint')}</p>
          </div>
          <button onClick={onClose} className="cursor-pointer shrink-0"><X size={20} /></button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.name')}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input-field" autoFocus />
          </div>
          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('g.nameUrdu')}</label>
            <input value={form.name_ur} onChange={(e) => setForm({ ...form, name_ur: e.target.value })} placeholder="اردو میں نام" className="input-field" style={{ fontFamily: 'var(--font-urdu), serif', direction: 'rtl' }} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('a.phone')}</label>
              <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0300-1234567" className="input-field" />
            </div>
            <div>
              <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.whatsapp')}</label>
              <input type="tel" value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} placeholder="0300-1234567" className="input-field" />
            </div>
          </div>
          <div>
            <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('w.fatherHusband')}</label>
            <input value={form.father_husband_name} onChange={(e) => setForm({ ...form, father_husband_name: e.target.value })} className="input-field" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">{t('f.donorType')}</label>
              <select
                value={form.donor_type}
                onChange={(e) => setForm({ ...form, donor_type: e.target.value, donor_location: e.target.value === 'villager' ? '' : form.donor_location })}
                className="input-field"
              >
                <option value="villager">{t('f.villager')}</option>
                <option value="city">{t('dn.cityInPakistan')}</option>
                <option value="overseas">{t('g.overseas')}</option>
              </select>
            </div>
            {form.donor_type !== 'villager' && (
              <div>
                <label className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2">
                  {form.donor_type === 'overseas' ? t('dn.country') : t('dn.city')}
                </label>
                <input
                  type="text" value={form.donor_location} onChange={(e) => setForm({ ...form, donor_location: e.target.value })}
                  placeholder={form.donor_type === 'overseas' ? t('dn.countryPlaceholder') : t('dn.cityPlaceholder')} className="input-field"
                />
              </div>
            )}
          </div>
          <button disabled={saving} onClick={save} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {saving ? t('dn.saving') : t('dn.addDonor')}
          </button>
        </div>
      </div>
    </div>
  )
}
