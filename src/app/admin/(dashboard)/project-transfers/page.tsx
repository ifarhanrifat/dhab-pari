'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { useSystemAccess } from '@/hooks/useSystemAccess'
import { SearchableField } from '@/components/admin/SearchablePicker'
import { ArrowRightLeft } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface Project { id: string; title: string; status: string }
interface AccountBalance { project_id: string; balance: number }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Cross-project fund transfer — for money raised on a project that isn't
// proceeding (rejected, stalled) and gets redirected to another approved,
// ongoing project. Deliberately requires a committee/agenda reference
// (transfer_project_funds, migration 139) rather than a free unilateral
// move — the actual approval decision happens at the meeting, this just
// records and posts it.
export default function ProjectTransfersPage() {
  const { t } = useLocale()
  const access = useSystemAccess()
  const [projects, setProjects] = useState<Project[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [amount, setAmount] = useState(0)
  const [reference, setReference] = useState('')
  const [saving, setSaving] = useState(false)
  const supabase = createClient()

  const load = async () => {
    const { data: projectRows } = await supabase.from('projects').select('id, title, status').order('title')
    setProjects(projectRows ?? [])
    const { data: accounts } = await supabase.from('accounts').select('id, project_id').not('project_id', 'is', null)
    if (accounts && accounts.length > 0) {
      const { data: legs } = await supabase.from('ledger_entries').select('account_id, debit, credit').in('account_id', accounts.map((a) => a.id))
      const byAccount: Record<string, number> = {}
      for (const l of legs ?? []) byAccount[l.account_id] = (byAccount[l.account_id] ?? 0) + Number(l.credit) - Number(l.debit)
      const byProject: Record<string, number> = {}
      for (const a of accounts) byProject[a.project_id] = byAccount[a.id] ?? 0
      setBalances(byProject)
    }
  }
  useEffect(() => { load() }, [])

  const submit = async () => {
    if (!fromId || !toId || fromId === toId) { toast.error('Choose two different projects'); return }
    if (!amount || amount <= 0) { toast.error('Enter a valid amount'); return }
    if (!reference.trim()) { toast.error('Enter the agenda/committee approval reference'); return }
    setSaving(true)
    const { error } = await supabase.rpc('transfer_project_funds', {
      p_from_project_id: fromId, p_to_project_id: toId, p_amount: amount, p_agenda_reference: reference.trim(),
    })
    setSaving(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Funds transferred')
    setFromId(''); setToId(''); setAmount(0); setReference('')
    load()
  }

  if (access.loading) return <div className="text-center py-12 text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  if (!access.canDonorsProjects) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-8 text-center">
        <p className="font-sans text-[14px] text-dp-on-surface-variant">Project Transfers belongs to the Donors &amp; Projects system — your account doesn&apos;t have access to it.</p>
      </div>
    )
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary flex items-center gap-2.5"><ArrowRightLeft size={26} /> Transfer Project Funds</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">Move raised funds from one project to another — requires the committee&apos;s agenda approval reference.</p>
      </div>

      <div className="bg-white border border-dp-outline-variant rounded-lg p-6 max-w-lg space-y-4">
        <SearchableField
          label="From Project (funds leave here)" value={fromId} onChange={setFromId} placeholder="Select project..."
          items={projects.map((p) => ({ id: p.id, label: `${p.title}${balances[p.id] != null ? ` — Rs. ${fmt(balances[p.id])}` : ''}` }))}
        />
        <SearchableField
          label="To Project (funds arrive here)" value={toId} onChange={setToId} placeholder="Select project..."
          items={projects.map((p) => ({ id: p.id, label: p.title }))}
        />
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.amountPkr')}</label>
          <input type="number" min={1} value={amount || ''} onChange={(e) => setAmount(+e.target.value)} className="input-field" />
        </div>
        <div>
          <label className="block font-sans text-[13px] font-semibold text-dp-on-surface-variant mb-1.5">Committee Agenda Approval Reference</label>
          <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Meeting 04 Aug 2026 — item #3" className="input-field" />
        </div>
        <button onClick={submit} disabled={saving} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
          {saving ? 'Transferring...' : 'Transfer Funds'}
        </button>
      </div>
    </>
  )
}
