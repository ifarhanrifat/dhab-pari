'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { X, UserCheck, UserX } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { PortalUserSearchPicker, type PortalUserLite } from '@/components/admin/PortalUserSearchPicker'

interface Account {
  id: string; side: 'groom' | 'bride'; family_name: string; payment_method: string
  account_number: string; account_title: string | null; bank_name: string | null
  manager_portal_user_id: string | null; manager?: PortalUserLite
}
const empty = { family_name: '', payment_method: 'easypaisa', account_number: '', account_title: '', bank_name: '' }

// Phase 3, 2026-09-30. Admin sets up the two payout accounts for a
// wedding after confirming the real family -- this is the trust
// boundary for the whole Online Salami feature (see migration 540).
//
// Real security correction, 2026-10-01: "this link part is unsecure what
// if it get leaked" -- replaced the copy-paste manage_token link with
// linking a real portal account instead (migration 554). That person
// logs in with their own credentials and sees their management tab from
// their own portal -- nothing to leak, and only ever visible to them.
export function SalamiAdminPanel({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const { t } = useLocale()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [forms, setForms] = useState<Record<'groom' | 'bride', typeof empty>>({ groom: { ...empty }, bride: { ...empty } })
  const supabase = createClient()

  const load = async () => {
    const { data } = await supabase.from('event_salami_accounts').select('*').eq('event_id', eventId)
    const rows = (data ?? []) as Account[]
    const managerIds = rows.map((r) => r.manager_portal_user_id).filter((id): id is string => !!id)
    if (managerIds.length > 0) {
      const { data: managers } = await supabase.from('portal_users').select('id, full_name, mobile').in('id', managerIds)
      rows.forEach((r) => { r.manager = managers?.find((m) => m.id === r.manager_portal_user_id) })
    }
    setAccounts(rows)
    const toForm = (r: Account | undefined) => r
      ? { family_name: r.family_name, payment_method: r.payment_method, account_number: r.account_number, account_title: r.account_title ?? '', bank_name: r.bank_name ?? '' }
      : { ...empty }
    setForms({
      groom: toForm(rows.find((r) => r.side === 'groom')),
      bride: toForm(rows.find((r) => r.side === 'bride')),
    })
    setLoading(false)
  }
  useEffect(() => { load() }, [eventId])

  const save = async (side: 'groom' | 'bride') => {
    const f = forms[side]
    if (!f.family_name.trim() || !f.account_number.trim()) { toast.error(t('sl.fillRequired')); return }
    const payload = {
      event_id: eventId, side, family_name: f.family_name.trim(), payment_method: f.payment_method,
      account_number: f.account_number.trim(), account_title: f.account_title.trim() || null, bank_name: f.bank_name.trim() || null,
    }
    const existing = accounts.find((a) => a.side === side)
    const { error } = existing
      ? await supabase.from('event_salami_accounts').update(payload).eq('id', existing.id)
      : await supabase.from('event_salami_accounts').insert(payload)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('sl.accountSaved'))
    load()
  }

  const linkManager = async (accountId: string, user: PortalUserLite) => {
    const { error } = await supabase.from('event_salami_accounts').update({ manager_portal_user_id: user.id }).eq('id', accountId)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('fnd.managerLinked'))
    load()
  }
  const unlinkManager = async (accountId: string) => {
    const { error } = await supabase.from('event_salami_accounts').update({ manager_portal_user_id: null }).eq('id', accountId)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success(t('fnd.managerUnlinked'))
    load()
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[110] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5"><h2 className="font-heading text-[22px] font-bold text-dp-primary">{t('sl.title')}</h2><button onClick={onClose} className="cursor-pointer"><X size={20} /></button></div>
        {loading ? <p className="text-center py-8 text-dp-on-surface-variant">…</p> : (
          <div className="space-y-6">
            {(['groom', 'bride'] as const).map((side) => {
              const existing = accounts.find((a) => a.side === side)
              return (
                <div key={side} className="border border-dp-outline-variant rounded-lg p-4">
                  <p className="font-sans text-[13px] font-bold uppercase text-dp-on-surface-variant mb-3">{t(`sl.side.${side}`)}</p>
                  <div className="space-y-3">
                    <input placeholder={t('sl.familyName')} value={forms[side].family_name} onChange={(e) => setForms({ ...forms, [side]: { ...forms[side], family_name: e.target.value } })} className="input-field" />
                    <div className="grid grid-cols-2 gap-3">
                      <select value={forms[side].payment_method} onChange={(e) => setForms({ ...forms, [side]: { ...forms[side], payment_method: e.target.value } })} className="input-field">
                        <option value="easypaisa">Easypaisa</option>
                        <option value="jazzcash">JazzCash</option>
                        <option value="bank">{t('sl.bank')}</option>
                      </select>
                      <input placeholder={t('sl.accountNumber')} value={forms[side].account_number} onChange={(e) => setForms({ ...forms, [side]: { ...forms[side], account_number: e.target.value } })} className="input-field" />
                    </div>
                    <input placeholder={t('sl.accountTitle')} value={forms[side].account_title} onChange={(e) => setForms({ ...forms, [side]: { ...forms[side], account_title: e.target.value } })} className="input-field" />
                    {forms[side].payment_method === 'bank' && (
                      <input placeholder={t('sl.bankName')} value={forms[side].bank_name} onChange={(e) => setForms({ ...forms, [side]: { ...forms[side], bank_name: e.target.value } })} className="input-field" />
                    )}
                    <button onClick={() => save(side)} className="w-full bg-dp-secondary text-white py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all">{existing ? t('ic.updateBtn') : t('sl.setUp')}</button>

                    {existing && (
                      <div className="border-t border-dp-outline-variant pt-3">
                        <p className="font-sans text-[12px] font-bold text-dp-on-surface-variant uppercase tracking-wide mb-2">{t('fnd.managedBy')}</p>
                        {existing.manager ? (
                          <div className="flex items-center justify-between gap-2 bg-emerald-50 rounded-lg p-2.5">
                            <span className="flex items-center gap-1.5 font-sans text-[13px] text-emerald-800"><UserCheck size={15} /> {existing.manager.full_name} · <span className="ltr-num">{existing.manager.mobile}</span></span>
                            <button onClick={() => unlinkManager(existing.id)} title={t('fnd.unlink')} className="p-1 text-emerald-700 hover:bg-emerald-100 rounded cursor-pointer"><UserX size={14} /></button>
                          </div>
                        ) : (
                          <PortalUserSearchPicker onPick={(u) => linkManager(existing.id, u)} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <p className="font-sans text-[11.5px] text-dp-on-surface-variant">{t('fnd.linkManagerNote')}</p>
          </div>
        )}
      </div>
    </div>
  )
}
