'use client'

import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface TrendPoint { month: string; income: number; expense: number }

export function IncomeExpenseChart({ data, incomeColor = '#059669', expenseColor = '#dc2626' }: {
  data: TrendPoint[]; incomeColor?: string; expenseColor?: string
}) {
  const { t } = useLocale()
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'var(--font-sans)' }} />
        <YAxis tick={{ fontSize: 11, fontFamily: 'var(--font-sans)' }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(value) => [`Rs. ${Number(value).toLocaleString()}`, '']}
          contentStyle={{ fontFamily: 'var(--font-sans)', fontSize: 13, borderRadius: 8 }}
        />
        <Legend wrapperStyle={{ fontFamily: 'var(--font-sans)', fontSize: 13 }} />
        <Bar dataKey="income" name={t('y.income')} fill={incomeColor} radius={[4, 4, 0, 0]} />
        <Bar dataKey="expense" name={t('y.expense')} fill={expenseColor} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

interface StockValuePoint { month: string; value: number }

// Reconstructed from the Inventory Stock GL control account's running balance
// (opening_balance + cumulative debit-credit at each month end) rather than a
// separate stored history — the ledger is already the single source of truth
// for "what was the stock worth," including weighted-average cost movements.
export function StockValueTrendChart({ data }: { data: StockValuePoint[] }) {
  const { t } = useLocale()
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="month" tick={{ fontSize: 12, fontFamily: 'var(--font-sans)' }} />
        <YAxis tick={{ fontSize: 11, fontFamily: 'var(--font-sans)' }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          formatter={(value) => [`Rs. ${Number(value).toLocaleString()}`, t('y.stockValue')]}
          contentStyle={{ fontFamily: 'var(--font-sans)', fontSize: 13, borderRadius: 8 }}
        />
        <Line type="monotone" dataKey="value" name={t('y.stockValue')} stroke="#0d9488" strokeWidth={2.5} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

interface FundSlice { name: string; value: number }
const PIE_COLORS = ['#0d9488', '#2563eb', '#d97706', '#7c3aed']

// Callers pass a fixed set of English slice names (Cash/Bank/Receivable) —
// translated here, in the one place that renders them, rather than asking
// every Server Component caller to pre-translate a plain data array.
const FUND_SLICE_KEYS: Record<string, string> = { Cash: 'dash.cash', Bank: 'dash.bank', Receivable: 'dash.receivable' }

export function FundPieChart({ data }: { data: FundSlice[] }) {
  const { t } = useLocale()
  const nonZero = data.filter((d) => d.value > 0).map((d) => ({ ...d, name: t(FUND_SLICE_KEYS[d.name] ?? '', d.name) }))
  if (nonZero.length === 0) {
    return <div className="h-[220px] flex items-center justify-center font-sans text-[13px] text-dp-on-surface-variant">{t('y.noFundData')}</div>
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={nonZero} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e: { name?: string; percent?: number }) => `${e.name ?? ''} ${((e.percent ?? 0) * 100).toFixed(0)}%`}>
          {nonZero.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip formatter={(value) => `Rs. ${Number(value).toLocaleString()}`} contentStyle={{ fontFamily: 'var(--font-sans)', fontSize: 13, borderRadius: 8 }} />
        <Legend wrapperStyle={{ fontFamily: 'var(--font-sans)', fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  )
}
