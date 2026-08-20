'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { History, RotateCcw, ShieldAlert, ArrowUpDown } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'

type TableName = 'bills' | 'payments' | 'donors' | 'vouchers' | 'accounts' | 'consumers'
type Action = 'insert' | 'update' | 'delete'

interface AuditRow {
  id: string
  table_name: TableName
  action: Action
  summary: string
  system: string | null
  actor_id: string | null
  actor_name: string | null
  performed_at: string
  restored_at: string | null
}

const tableLabels: Record<TableName, string> = {
  bills: 'Water Bill', payments: 'Payment', donors: 'Donation', vouchers: 'Voucher',
  accounts: 'Account', consumers: 'Consumer',
}
const tableColors: Record<TableName, string> = {
  bills: 'bg-blue-100 text-blue-800', payments: 'bg-emerald-100 text-emerald-700',
  donors: 'bg-violet-100 text-violet-800', vouchers: 'bg-amber-100 text-amber-800',
  accounts: 'bg-cyan-100 text-cyan-800', consumers: 'bg-pink-100 text-pink-800',
}
const actionLabels: Record<Action, string> = { insert: 'Created', update: 'Updated', delete: 'Deleted' }
const actionColors: Record<Action, string> = {
  insert: 'bg-emerald-100 text-emerald-700', update: 'bg-amber-100 text-amber-800', delete: 'bg-red-100 text-red-700',
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function AuditLogPage() {
  const { t, isUrdu } = useLocale()
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [canRestore, setCanRestore] = useState(false)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmRestore, setConfirmRestore] = useState<AuditRow | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [actorFilter, setActorFilter] = useState('')
  const [actionFilter, setActionFilter] = useState<'all' | Action>('all')
  const [sortAsc, setSortAsc] = useState(false)
  const supabase = createClient()

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setAuthorized(false); setLoading(false); return }
    const { data: profile } = await supabase.from('admin_users').select('role, can_restore_deleted').eq('auth_user_id', user.id).single()
    if (profile?.role !== 'super_admin' && profile?.role !== 'admin') { setAuthorized(false); setLoading(false); return }
    setAuthorized(true)
    setCanRestore(profile.role === 'super_admin' || !!profile.can_restore_deleted)

    const { data } = await supabase.from('audit_log').select('*').order('performed_at', { ascending: false })
    setRows(data ?? [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  const actors = useMemo(() => {
    const seen = new Map<string, string>()
    rows.forEach((r) => { if (r.actor_id) seen.set(r.actor_id, r.actor_name ?? 'Unknown') })
    return Array.from(seen.entries())
  }, [rows])

  const filteredRows = useMemo(() => {
    let list = rows
    if (actorFilter) list = list.filter((r) => r.actor_id === actorFilter)
    if (actionFilter !== 'all') list = list.filter((r) => r.action === actionFilter)
    const sorted = [...list].sort((a, b) => new Date(a.performed_at).getTime() - new Date(b.performed_at).getTime())
    return sortAsc ? sorted : sorted.reverse()
  }, [rows, actorFilter, actionFilter, sortAsc])

  const restore = async () => {
    if (!confirmRestore) return
    setRestoring(true)
    const { error } = await supabase.rpc('restore_deleted_record', { p_audit_id: confirmRestore.id })
    setRestoring(false)
    if (error) { toast.error(friendlyError(error)); return }
    toast.success('Record restored')
    setConfirmRestore(null)
    load()
  }

  if (loading) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans">{t('action.loading')}</div>
  }

  if (!authorized) {
    return (
      <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center">
        <ShieldAlert size={32} className="mx-auto mb-3 text-dp-error" />
        <p className="font-sans text-dp-on-surface-variant">{t('z.auditRestricted')}</p>
      </div>
    )
  }

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'}>
      <div className="mb-6">
        <h1 className="font-heading text-[28px] font-bold leading-[36px] text-dp-primary flex items-center gap-2.5">
          <History size={26} /> {t('z.auditLog')}
        </h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1">
          Every record created, edited, or deleted by every user — deleted records can be restored.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('z.user')}</label>
          <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)} className="input-field">
            <option value="">{t('z.allUsers')}</option>
            {actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        <div>
          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('w.action')}</label>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value as 'all' | Action)} className="input-field">
            <option value="all">{t('z.allActions')}</option>
            <option value="insert">{t('z.created')}</option>
            <option value="update">{t('z.updated')}</option>
            <option value="delete">{t('z.deleted')}</option>
          </select>
        </div>
        <button onClick={() => setSortAsc((s) => !s)} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          <ArrowUpDown size={15} /> {sortAsc ? 'Oldest First' : 'Newest First'}
        </button>
        <span className="font-sans text-[12.5px] text-dp-on-surface-variant ms-auto">{filteredRows.length} of {rows.length} records</span>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-start min-w-[820px]">
            <thead>
              <tr className="text-dp-on-surface-variant text-[12px] font-sans font-bold tracking-[0.05em] border-b border-dp-outline-variant bg-dp-surface-container-low/60">
                <th className="px-4 py-2.5">{t('a.type')}</th>
                <th className="px-4 py-2.5">{t('w.action')}</th>
                <th className="px-4 py-2.5">{t('z.summary')}</th>
                <th className="px-4 py-2.5">{t('z.user')}</th>
                <th className="px-4 py-2.5">{t('z.when')}</th>
                <th className="px-4 py-2.5">{t('w.status')}</th>
                <th className="px-4 py-2.5 text-end">{t('a.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-dp-on-surface-variant font-sans">{t('z.noActivity')}</td></tr>
              )}
              {filteredRows.map((r) => (
                <tr key={r.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${r.restored_at ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${tableColors[r.table_name]}`}>{tableLabels[r.table_name]}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${actionColors[r.action]}`}>{actionLabels[r.action]}</span>
                  </td>
                  <td className="px-4 py-3">{r.summary}</td>
                  <td className="px-4 py-3">{r.actor_name ?? '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDateTime(r.performed_at)}</td>
                  <td className="px-4 py-3">
                    {r.action !== 'delete' ? (
                      <span className="text-[11px] text-dp-on-surface-variant">—</span>
                    ) : r.restored_at ? (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{t('z.restored')}</span>
                    ) : (
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">{t('z.deleted')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end">
                    {r.action === 'delete' && !r.restored_at && canRestore && (
                      <button onClick={() => setConfirmRestore(r)} className="flex items-center gap-1.5 px-3 py-1.5 bg-dp-secondary text-white rounded-lg font-sans text-[12.5px] font-semibold hover:bg-dp-primary transition-all cursor-pointer ms-auto">
                        <RotateCcw size={13} /> {t('g.restore')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmRestore}
        title="Restore Record"
        message={`This will bring back "${confirmRestore?.summary ?? ''}" exactly as it was, including its ledger entries. Continue?`}
        confirmLabel={restoring ? 'Restoring...' : 'Restore'}
        onConfirm={restore}
        onCancel={() => setConfirmRestore(null)}
      />
    </div>
  )
}
