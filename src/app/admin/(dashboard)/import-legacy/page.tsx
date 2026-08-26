'use client'

// One-off (but safely re-runnable) bridge from the committee's old
// BookKeeper ledger into this system's real donation/project pipeline.
// Two-step by design — nothing is written until the admin has actually
// seen the numbers this file produces and pressed Start Import.
import { useState } from 'react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/i18n/LocaleProvider'
import { UploadCloud, AlertTriangle, CheckCircle2, Loader2, FolderKanban, Users, HeartHandshake, Receipt } from 'lucide-react'
import type { LegacyImportData } from '@/lib/legacyImport/parseBookKeeper'

const BATCH_SIZE = 25

type Phase = 'idle' | 'analyzing' | 'previewed' | 'importing' | 'done'

export default function ImportLegacyPage() {
  const { t, isUrdu } = useLocale()
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [data, setData] = useState<LegacyImportData | null>(null)
  const [progress, setProgress] = useState({ label: '', done: 0, total: 0 })
  const [result, setResult] = useState({ projects: 0, donations: 0, expenses: 0, expenseReversals: 0, errors: [] as string[] })

  const analyze = async () => {
    if (!file) return
    setPhase('analyzing')
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/admin/import-legacy/preview', { method: 'POST', body: form })
    const json = await res.json()
    if (!res.ok) { toast.error(json.error ?? 'Could not read this file.'); setPhase('idle'); return }
    setData(json as LegacyImportData)
    setPhase('previewed')
  }

  const runBatches = async <T,>(phaseName: 'projects' | 'donations' | 'expenses' | 'expenseReversals', items: T[], label: string) => {
    let imported = 0
    const errors: string[] = []
    if (phaseName === 'projects') {
      // Projects always go in one call — there are only a handful (~16),
      // and every donation/expense batch after this depends on them all
      // already being logged in legacy_import_records.
      setProgress({ label, done: 0, total: items.length })
      const res = await fetch('/api/admin/import-legacy/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: phaseName, items }),
      })
      const json = await res.json()
      setProgress({ label, done: items.length, total: items.length })
      return { imported: json.imported ?? 0, errors: json.errors ?? [] }
    }
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE)
      setProgress({ label, done: i, total: items.length })
      const res = await fetch('/api/admin/import-legacy/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase: phaseName, items: batch }),
      })
      const json = await res.json()
      imported += json.imported ?? 0
      errors.push(...(json.errors ?? []))
    }
    setProgress({ label, done: items.length, total: items.length })
    return { imported, errors }
  }

  const startImport = async () => {
    if (!data) return
    setPhase('importing')
    const allErrors: string[] = []

    const projRes = await runBatches('projects', data.projects, t('il.phaseProjects'))
    allErrors.push(...projRes.errors)

    const donRes = await runBatches('donations', data.donations, t('il.phaseDonations'))
    allErrors.push(...donRes.errors)

    const expRes = await runBatches('expenses', data.expenses, t('il.phaseExpenses'))
    allErrors.push(...expRes.errors)

    const revRes = await runBatches('expenseReversals', data.expenseReversals, t('il.phaseExpenseReversals'))
    allErrors.push(...revRes.errors)

    setResult({ projects: projRes.imported, donations: donRes.imported, expenses: expRes.imported, expenseReversals: revRes.imported, errors: allErrors })
    setPhase('done')
    toast.success(t('il.importDone'))
  }

  const fmt = (n: number) => Math.round(n).toLocaleString()

  return (
    <div dir={isUrdu ? 'rtl' : 'ltr'} className="max-w-3xl">
      <div className="mb-6">
        <h1 className="font-heading text-[26px] font-bold text-dp-primary flex items-center gap-2"><UploadCloud size={22} className="text-dp-secondary" /> {t('il.title')}</h1>
        <p className="font-sans text-[13.5px] text-dp-on-surface-variant mt-1.5 leading-relaxed">{t('il.blurb')}</p>
      </div>

      {phase === 'idle' || phase === 'analyzing' ? (
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 flex items-center gap-3 flex-wrap">
          <input type="file" accept=".db,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-[13px] font-sans" />
          <button onClick={analyze} disabled={!file || phase === 'analyzing'}
            className="flex items-center gap-1.5 bg-dp-secondary text-white px-4 py-2 rounded-lg font-sans text-[13px] font-semibold cursor-pointer hover:bg-dp-primary transition-all disabled:opacity-50">
            {phase === 'analyzing' ? <><Loader2 size={14} className="animate-spin" /> {t('il.analyzing')}</> : t('il.analyze')}
          </button>
        </div>
      ) : null}

      {data && (phase === 'previewed' || phase === 'importing' || phase === 'done') && (
        <div className="space-y-5 mt-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={<FolderKanban size={16} />} label={t('il.projects')} value={data.projects.length} />
            <StatCard icon={<Users size={16} />} label={t('il.donors')} value={new Set(data.donations.map((d) => d.donorName)).size} />
            <StatCard icon={<HeartHandshake size={16} />} label={t('il.donations')} value={data.donations.length} sub={`Rs. ${fmt(data.donations.reduce((s, d) => s + d.amount, 0))}`} />
            <StatCard icon={<Receipt size={16} />} label={t('il.expenses')} value={data.expenses.length} sub={`Rs. ${fmt(data.expenses.reduce((s, e) => s + e.amount, 0))}`} />
          </div>

          <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
            <h2 className="font-sans text-[13px] font-bold text-dp-on-surface mb-3">{t('il.projects')}</h2>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.projects.map((p) => {
                const total = data.donations.filter((d) => d.projectAname === p.aname).reduce((s, d) => s + d.amount, 0)
                const spent = data.expenses.filter((e) => e.projectAname === p.aname).reduce((s, e) => s + e.amount, 0)
                return (
                  <div key={p.aname} className="flex items-center justify-between gap-3 text-[12.5px] font-sans py-1 border-b border-dp-outline-variant/50 last:border-0">
                    <span className="text-dp-on-surface truncate">{p.aname}</span>
                    <span className="text-dp-on-surface-variant shrink-0">Rs. {fmt(total)} {t('il.donations').toLowerCase()} · Rs. {fmt(spent)} {t('il.expenses').toLowerCase()}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {data.anomalies.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-2.5">
              <AlertTriangle size={16} className="text-amber-700 shrink-0 mt-0.5" />
              <div>
                <p className="font-sans text-[13px] font-bold text-amber-900">{t('il.anomaliesTitle')}</p>
                <p className="font-sans text-[12.5px] text-amber-900/80 mt-1">{t('il.anomaliesBody')}</p>
                <ul className="mt-2 space-y-1">
                  {data.anomalies.map((a) => (
                    <li key={a.vchNo} className="font-sans text-[12px] text-amber-900">{a.date} · {a.vchNo} · Rs. {fmt(a.amount)} · {a.credit} → {a.debit}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {phase === 'previewed' && (
            <button onClick={startImport} className="w-full bg-dp-secondary text-white py-3 rounded-lg font-sans font-semibold cursor-pointer hover:bg-dp-primary transition-all">
              {t('il.startImport')}
            </button>
          )}

          {phase === 'importing' && (
            <div className="bg-white border border-dp-outline-variant rounded-lg p-4">
              <p className="font-sans text-[13px] font-semibold text-dp-on-surface flex items-center gap-2"><Loader2 size={15} className="animate-spin text-dp-secondary" /> {progress.label} — {progress.done}/{progress.total}</p>
              <div className="h-2 bg-dp-surface-container-low rounded-full overflow-hidden mt-2">
                <div className="h-full bg-dp-secondary transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="bg-dp-secondary-container/40 border border-dp-secondary/30 rounded-lg p-4">
              <p className="font-sans text-[13.5px] font-bold text-dp-on-surface flex items-center gap-2"><CheckCircle2 size={16} className="text-dp-secondary" /> {t('il.importDone')}</p>
              <p className="font-sans text-[12.5px] text-dp-on-surface-variant mt-1">
                {result.projects} {t('il.projects').toLowerCase()} · {result.donations} {t('il.donations').toLowerCase()} · {result.expenses} {t('il.expenses').toLowerCase()}
                {result.expenseReversals > 0 ? ` · ${result.expenseReversals} ${t('il.phaseExpenseReversals').toLowerCase()}` : ''}
              </p>
              {result.errors.length > 0 && (
                <div className="mt-3 bg-white rounded-lg p-3 max-h-48 overflow-y-auto">
                  <p className="font-sans text-[12px] font-bold text-dp-error mb-1">{t('il.errorsTitle')} ({result.errors.length})</p>
                  {result.errors.map((e, i) => <p key={i} className="font-sans text-[11.5px] text-dp-on-surface-variant">{e}</p>)}
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <a href="/admin/projects" className="text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline">{t('il.reviewProjects')}</a>
                <a href="/admin/donors" className="text-[12.5px] font-sans font-semibold text-dp-secondary hover:underline">{t('il.reviewDonors')}</a>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg p-3.5">
      <p className="flex items-center gap-1.5 font-sans text-[11px] font-semibold text-dp-on-surface-variant uppercase tracking-wide">{icon} {label}</p>
      <p className="font-heading text-[19px] font-bold text-dp-primary mt-1">{value.toLocaleString()}</p>
      {sub && <p className="font-sans text-[11px] text-dp-on-surface-variant">{sub}</p>}
    </div>
  )
}
