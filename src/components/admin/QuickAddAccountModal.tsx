'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { X, Save } from 'lucide-react'

export interface NewAccount { id: string; code: string; name: string; type: string }

interface Props {
  system: 'water_supply' | 'donors_projects'
  allowedTypes: string[]
  onClose: () => void
  onCreated: (account: NewAccount) => void
}

const typeLabels: Record<string, string> = {
  cash: 'Cash', bank: 'Bank', expense: 'Expense', income: 'Income', asset: 'Asset', liability: 'Liability',
}

// Dropped as a "+ New Account" link next to any account picker in a transaction
// form — resolves the matching account_headers row for the chosen type so the
// user never has to leave the transaction to set one up in Chart of Accounts first.
export function QuickAddAccountModal({ system, allowedTypes, onClose, onCreated }: Props) {
  const supabase = createClient()
  const [type, setType] = useState(allowedTypes[0])
  const [name, setName] = useState('')
  const [openingBalance, setOpeningBalance] = useState(0)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    const { data: header, error: headerErr } = await supabase.from('account_headers')
      .select('id').eq('system', system).eq('code', type).maybeSingle()
    if (headerErr || !header) {
      toast.error(`No "${typeLabels[type] ?? type}" account header set up for this system yet — create one from Chart of Accounts first`)
      setSaving(false); return
    }
    const { data: code, error: codeError } = await supabase.rpc('next_account_code', { p_header_id: header.id })
    if (codeError) { toast.error(codeError.message); setSaving(false); return }
    const { data, error } = await supabase.from('accounts').insert({
      code, name, system, type, opening_balance: openingBalance || 0,
    }).select('id, code, name, type').single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Account created (${code})`)
    onCreated(data)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-heading text-[18px] font-bold text-dp-primary">New Account</h2>
          <button onClick={onClose} className="cursor-pointer text-dp-on-surface-variant"><X size={20} /></button>
        </div>
        <div className="space-y-4">
          {allowedTypes.length > 1 && (
            <div>
              <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Account Type</label>
              <select value={type} onChange={(e) => setType(e.target.value)} className="input-field">
                {allowedTypes.map((t) => <option key={t} value={t}>{typeLabels[t] ?? t}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Name</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="input-field" placeholder="e.g. Fuel &amp; Transport" />
          </div>
          <div>
            <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Opening Balance (optional)</label>
            <input type="number" value={openingBalance || ''} onChange={(e) => setOpeningBalance(+e.target.value)} className="input-field" />
          </div>
          <button disabled={saving} onClick={save} className="w-full flex items-center justify-center gap-2 bg-dp-secondary text-white py-2.5 rounded-lg font-sans font-semibold hover:bg-dp-primary transition-all cursor-pointer disabled:opacity-50">
            <Save size={16} /> {saving ? 'Creating...' : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  )
}
