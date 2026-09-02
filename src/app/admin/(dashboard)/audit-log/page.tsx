'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { History, RotateCcw, ShieldAlert, ArrowUpDown } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { ConfirmDialog } from '@/components/admin/ConfirmDialog'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { LoadingDots } from '@/components/shared/LoadingDots'

type TableName = 'bills' | 'payments' | 'donors' | 'vouchers' | 'accounts' | 'consumers'
type Action = 'insert' | 'update' | 'delete' | 'reverse'

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

// Values are i18n keys — resolved via t() at render time (module scope has
// no useLocale()).
const tableLabelKeys: Record<TableName, string> = {
  bills: 'z.table.bills', payments: 'z.table.payments', donors: 'z.table.donors', vouchers: 'z.table.vouchers',
  accounts: 'z.table.accounts', consumers: 'z.table.consumers',
}
const tableColors: Record<TableName, string> = {
  bills: 'bg-blue-100 text-blue-800', payments: 'bg-emerald-100 text-emerald-700',
  donors: 'bg-violet-100 text-violet-800', vouchers: 'bg-amber-100 text-amber-800',
  accounts: 'bg-cyan-100 text-cyan-800', consumers: 'bg-pink-100 text-pink-800',
}
const actionLabelKeys: Record<Action, string> = { insert: 'z.created', update: 'z.updated', delete: 'z.deleted', reverse: 'z.reversed' }
const actionColors: Record<Action, string> = {
  insert: 'bg-emerald-100 text-emerald-700', update: 'bg-amber-100 text-amber-800', delete: 'bg-red-100 text-red-700',
  reverse: 'bg-sky-100 text-sky-700',
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Pakistan-local, not UTC — the server/browser's UTC "today" is still
// yesterday for five hours every evening in Pakistan, which would silently
// exclude anything done that evening from the "today"/"this month" default
// (same class of bug src/lib/periodLock.ts's todayInPakistan() exists to
// avoid for period locking).
function todayInPakistan(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}
const today = () => todayInPakistan()
const monthStart = () => `${todayInPakistan().slice(0, 7)}-01`

export default function AuditLogPage() {
  const { t, isUrdu } = useLocale()
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [canRestore, setCanRestore] = useState(false)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [confirmRestore, setConfirmRestore] = useState<AuditRow | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [actorFilter, setActorFilter] = useState('')
  const [actionFilter, setActionFilter] = useState<'all' | Action>('all')
  const [sortAsc, setSortAsc] = useState(false)
  // Unfiltered, this pulled the entire audit_log table — every insert/update/
  // delete since the app went live, each row carrying full before/after
  // JSONB snapshots — and rendered all of it at once. Defaults to today
  // only, same date-range pattern as All Transactions, so opening this page
  // no longer means a multi-second hang while hundreds of rows (and
  // growing) load and render.
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(today())
  const supabase = createClient()

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setAuthorized(false); setLoading(false); return }
    const { data: profile } = await supabase.from('admin_users').select('role, can_restore_deleted').eq('auth_user_id', user.id).single()
    if (profile?.role !== 'super_admin' && profile?.role !== 'admin') { setAuthorized(false); setLoading(false); return }
    setAuthorized(true)
    setCanRestore(profile.role === 'super_admin' || !!profile.can_restore_deleted)

    setRowsLoading(true)
    // Explicit +05:00 offset, not a bare date — performed_at is timestamptz,
    // and a bare 'YYYY-MM-DD' gets interpreted in whatever timezone the DB
    // session happens to be in (UTC by default), silently shifting the
    // Pakistan-local day boundary by 5 hours.
    const { data } = await supabase.from('audit_log').select('*')
      .gte('performed_at', new Date(`${from}T00:00:00+05:00`).toISOString())
      .lte('performed_at', new Date(`${to}T23:59:59+05:00`).toISOString())
      .order('performed_at', { ascending: false })
    setRows(data ?? [])
    setRowsLoading(false)
    setLoading(false)
  }, [supabase, from, to])

  useEffect(() => { load() }, [load])
  const setCurrentMonth = () => { setFrom(monthStart()); setTo(today()) }
  const setCurrentDay = () => { setFrom(today()); setTo(today()) }

  const actors = useMemo(() => {
    const seen = new Map<string, string>()
    rows.forEach((r) => { if (r.actor_id) seen.set(r.actor_id, r.actor_name ?? t('z.unknown')) })
    return Array.from(seen.entries())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t])

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
    toast.success(t('z.recordRestored'))
    setConfirmRestore(null)
    load()
  }

  if (loading) {
    return <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center text-dp-on-surface-variant font-sans"><LoadingDots /></div>
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
          {t('z.auditLogBlurb')}
        </p>
      </div>

      <div className="bg-white rounded-lg border border-dp-outline-variant p-4 mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('a.from')}</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-field !py-2 text-[14px]" />
        </div>
        <div>
          <label className="block font-sans text-[12px] font-semibold text-dp-on-surface-variant mb-1.5">{t('tx.to')}</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-field !py-2 text-[14px]" />
        </div>
        <button onClick={setCurrentDay} className="px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          {t('y.today')}
        </button>
        <button onClick={setCurrentMonth} className="px-3 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          {t('tx.thisMonth')}
        </button>
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
            <option value="reverse">{t('z.reversed')}</option>
          </select>
        </div>
        <button onClick={() => setSortAsc((s) => !s)} className="flex items-center gap-2 px-4 py-2 border border-dp-outline-variant rounded-lg font-sans text-[13.5px] font-semibold text-dp-on-surface hover:bg-dp-surface-container-low transition-all cursor-pointer">
          <ArrowUpDown size={15} /> {sortAsc ? t('z.oldestFirst') : t('z.newestFirst')}
        </button>
        <span className="font-sans text-[12.5px] text-dp-on-surface-variant ms-auto">{t('z.recordsOf').replace('{shown}', String(filteredRows.length)).replace('{total}', String(rows.length))}</span>
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
              {rowsLoading ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-dp-on-surface-variant font-sans"><LoadingDots /></td></tr>
              ) : filteredRows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-dp-on-surface-variant font-sans">{t('z.noActivity')}</td></tr>
              )}
              {!rowsLoading && filteredRows.map((r) => (
                <tr key={r.id} className={`font-sans text-[13.5px] border-b border-dp-outline-variant last:border-b-0 ${r.restored_at ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${tableColors[r.table_name]}`}>{t(tableLabelKeys[r.table_name])}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${actionColors[r.action]}`}>{t(actionLabelKeys[r.action])}</span>
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
        title={t('z.restoreRecordTitle')}
        message={t('z.restoreRecordMessage').replace('{summary}', confirmRestore?.summary ?? '')}
        confirmLabel={restoring ? t('z.restoring') : t('g.restore')}
        onConfirm={restore}
        onCancel={() => setConfirmRestore(null)}
      />
    </div>
  )
}
