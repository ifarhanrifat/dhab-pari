'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { History } from 'lucide-react'
import { toast } from 'sonner'
import { friendlyError } from '@/lib/errors'
import { LoadingDots } from '@/components/shared/LoadingDots'

interface AuditRow {
  id: string
  actor_name: string | null
  action: string
  details: Record<string, unknown> | null
  performed_at: string
  tenants: { name: string } | null
}

const actionLabels: Record<string, string> = {
  tenant_created: 'Tenant created',
  tenant_edited: 'Tenant edited',
  tenant_activated: 'Tenant activated',
  tenant_deactivated: 'Tenant deactivated',
  module_toggled: 'Module toggled',
  tenant_subscribed: 'Subscribed',
  tenant_admin_created: 'Admin created',
  invoice_marked_paid: 'Invoice marked paid',
}

const actionColors: Record<string, string> = {
  tenant_created: 'bg-emerald-100 text-emerald-700',
  tenant_edited: 'bg-amber-100 text-amber-800',
  tenant_activated: 'bg-green-100 text-green-800',
  tenant_deactivated: 'bg-red-100 text-red-700',
  module_toggled: 'bg-sky-100 text-sky-700',
  tenant_subscribed: 'bg-violet-100 text-violet-800',
  tenant_admin_created: 'bg-cyan-100 text-cyan-800',
  invoice_marked_paid: 'bg-emerald-100 text-emerald-700',
}

function fmtDateTime(d: string) {
  return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function PlatformAuditLogPage() {
  const supabase = createClient()
  const [rows, setRows] = useState<AuditRow[] | null>(null)

  useEffect(() => {
    supabase.from('platform_audit_log')
      .select('id, actor_name, action, details, performed_at, tenants(name)')
      .order('performed_at', { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (error) { toast.error(friendlyError(error)); return }
        setRows(data as unknown as AuditRow[])
      })
  }, [])

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-on-surface">Audit Log</h1>
        <p className="text-dp-on-surface-variant text-[13px] font-sans mt-0.5">
          Every platform-level action — tenant creation/edits, module toggles, subscriptions, invoices.
        </p>
      </div>

      {rows === null ? (
        <div className="flex justify-center py-16"><LoadingDots /></div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-10 text-center">
          <History size={28} className="mx-auto text-dp-on-surface-variant mb-3" />
          <p className="font-sans text-dp-on-surface-variant">No activity recorded yet.</p>
        </div>
      ) : (
        <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden overflow-x-auto">
          <table className="w-full text-[13.5px] font-sans">
            <thead className="bg-dp-surface-container text-dp-on-surface-variant text-left">
              <tr>
                <th className="px-4 py-3 font-semibold">When</th>
                <th className="px-4 py-3 font-semibold">Actor</th>
                <th className="px-4 py-3 font-semibold">Action</th>
                <th className="px-4 py-3 font-semibold">Tenant</th>
                <th className="px-4 py-3 font-semibold">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-dp-outline-variant">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtDateTime(r.performed_at)}</td>
                  <td className="px-4 py-3">{r.actor_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${actionColors[r.action] ?? 'bg-gray-100 text-gray-600'}`}>
                      {actionLabels[r.action] ?? r.action}
                    </span>
                  </td>
                  <td className="px-4 py-3">{r.tenants?.name ?? '—'}</td>
                  <td className="px-4 py-3 text-dp-on-surface-variant text-[12.5px] max-w-[320px] truncate" title={JSON.stringify(r.details)}>
                    {r.details ? JSON.stringify(r.details) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
