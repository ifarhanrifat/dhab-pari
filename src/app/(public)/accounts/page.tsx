import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = {
  title: 'Accounts & Transparency',
  description: `Full financial transparency for ${SITE.name} village — income, expenses, and community fund status.`,
}

// Not per-visitor, but a trust-critical financial-transparency page — kept
// fresher than the mostly-static pages (1 minute) rather than the longer
// windows used elsewhere.
export const revalidate = 60
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Info,
  Building2,
} from 'lucide-react'
import { SITE } from '@/lib/constants'
import { T } from '@/components/i18n/T'

export default async function AccountsPage() {
  const supabase = await createClient()

  const { data: transactions } = await supabase
    .from('transactions')
    .select('*')
    .order('date', { ascending: false })
    .limit(10)

  const allTxns = transactions ?? []

  const totalIncome = allTxns
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + Number(t.amount_pkr), 0)
  const totalExpense = allTxns
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + Number(t.amount_pkr), 0)
  const netBalance = totalIncome - totalExpense

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const categoryBadge = (cat: string) => (
    <span className="bg-dp-surface-container-high px-2 py-1 rounded text-[12px] font-sans">
      {cat}
    </span>
  )

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary section-title">
            <T k="x.accountsTransparency" />
          </h1>
          <p
            className="text-dp-on-surface-variant text-[20px] mt-1"
            style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
          >
            حسابات اور شفافیت
          </p>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg border border-dp-outline-variant flex items-center gap-5">
          <div className="w-14 h-14 rounded-full bg-dp-secondary-container text-dp-on-secondary-container flex items-center justify-center shrink-0">
            <TrendingUp size={24} />
          </div>
          <div>
            <p className="font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant uppercase">
              <T k="x.totalIncome" />
            </p>
            <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-secondary">
              Rs. {totalIncome.toLocaleString()}
            </h2>
            <p className="text-[12px] text-dp-secondary font-semibold font-sans mt-1">
              +12% from last month
            </p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg border border-dp-outline-variant flex items-center gap-5">
          <div className="w-14 h-14 rounded-full bg-dp-error-container text-dp-on-error-container flex items-center justify-center shrink-0">
            <TrendingDown size={24} />
          </div>
          <div>
            <p className="font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant uppercase">
              <T k="x.totalExpenses" />
            </p>
            <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-error">
              Rs. {totalExpense.toLocaleString()}
            </h2>
            <p className="text-[12px] text-dp-error font-semibold font-sans mt-1">
              <T k="x.withinBudget" />
            </p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg border border-dp-outline-variant flex items-center gap-5">
          <div className="w-14 h-14 rounded-full bg-dp-tertiary-fixed text-dp-on-tertiary-fixed flex items-center justify-center shrink-0">
            <Wallet size={24} />
          </div>
          <div>
            <p className="font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant uppercase">
              <T k="x.netBalance" />
            </p>
            <h2 className="font-heading text-[32px] font-bold leading-[40px] text-dp-tertiary-container">
              Rs. {netBalance.toLocaleString()}
            </h2>
            <p className="text-[12px] text-dp-tertiary-container font-semibold font-sans mt-1">
              <T k="x.villageFundReserve" />
            </p>
          </div>
        </div>
      </div>

      {/* Two column: table + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Main Table */}
        <div className="lg:col-span-8">
          <div className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
            <div className="px-6 py-5 border-b border-dp-outline-variant">
              <h3 className="font-sans text-[20px] font-semibold leading-[28px]">
                <T k="x.recentTransactions" />
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-start">
                <thead className="bg-dp-surface-container text-dp-on-surface-variant font-sans text-[14px] font-semibold tracking-[0.05em]">
                  <tr>
                    <th className="px-6 py-4"><T k="w.date" /></th>
                    <th className="px-6 py-4"><T k="x.description" /></th>
                    <th className="px-6 py-4"><T k="w.category" /></th>
                    <th className="px-6 py-4"><T k="x.type" /></th>
                    <th className="px-6 py-4 text-end"><T k="w.amount" /></th>
                  </tr>
                </thead>
                <tbody className="font-sans text-[16px]">
                  {allTxns.map((txn, i) => (
                    <tr
                      key={txn.id}
                      className={`border-s-4 ${txn.type === 'income' ? 'border-s-dp-secondary' : 'border-s-dp-error'} ${i % 2 === 1 ? 'bg-dp-surface-container' : ''} hover:bg-dp-surface-container-low transition-colors`}
                    >
                      <td className="px-6 py-4 text-dp-on-surface-variant text-[14px]">
                        {formatDate(txn.date)}
                      </td>
                      <td className="px-6 py-4 font-semibold">{txn.description}</td>
                      <td className="px-6 py-4">{categoryBadge(txn.category)}</td>
                      <td className="px-6 py-4">
                        {txn.type === 'income' ? (
                          <span className="bg-dp-secondary text-white px-3 py-1 rounded-full text-[12px] font-bold uppercase tracking-wider font-sans">
                            <T k="x.income" />
                          </span>
                        ) : (
                          <span className="bg-dp-error text-white px-3 py-1 rounded-full text-[12px] font-bold uppercase tracking-wider font-sans">
                            <T k="x.expense" />
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-6 py-4 text-end font-bold ${txn.type === 'income' ? 'text-dp-secondary' : 'text-dp-error'}`}
                      >
                        Rs. {Number(txn.amount_pkr).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-4 border-t border-dp-outline-variant flex justify-between items-center">
              <span className="text-[14px] text-dp-on-surface-variant font-sans">
                Showing {allTxns.length} transactions
              </span>
              <div className="flex gap-2">
                <button className="px-3 py-1 border border-dp-outline-variant rounded hover:bg-dp-surface-container transition-colors font-sans text-[14px] disabled:opacity-30 cursor-pointer">
                  <T k="x.prev" />
                </button>
                <button className="px-3 py-1 bg-dp-primary text-white rounded hover:opacity-90 transition-opacity font-sans text-[14px] cursor-pointer">
                  <T k="x.next" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="lg:col-span-4 space-y-6">
          {/* Cash Position */}
          <div className="bg-white p-6 rounded-lg border border-dp-outline-variant">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-sans text-[20px] font-semibold leading-[28px]"><T k="g.cashPosition" /></h3>
              <Building2 size={20} className="text-dp-primary" />
            </div>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-[14px] mb-1 font-sans">
                  <span className="text-dp-on-surface-variant"><T k="x.reserveGoal" /></span>
                  <span className="font-semibold text-dp-secondary">85%</span>
                </div>
                <div className="w-full h-3 bg-dp-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-dp-secondary" style={{ width: '85%' }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div className="p-3 bg-dp-surface-container rounded-lg">
                  <p className="text-[10px] uppercase text-dp-on-surface-variant tracking-wider font-sans">
                    <T k="x.cashInHand" />
                  </p>
                  <p className="font-bold text-dp-on-surface font-sans">Rs. 12,450</p>
                </div>
                <div className="p-3 bg-dp-surface-container rounded-lg">
                  <p className="text-[10px] uppercase text-dp-on-surface-variant tracking-wider font-sans">
                    <T k="x.bankBalance" />
                  </p>
                  <p className="font-bold text-dp-on-surface font-sans">Rs. 123,710</p>
                </div>
              </div>
            </div>
          </div>

          {/* Monthly Growth */}
          <div className="bg-dp-primary p-6 rounded-lg text-white relative overflow-hidden h-64">
            <h3 className="font-sans text-[20px] font-semibold leading-[28px] mb-2 relative z-10">
              <T k="x.monthlyGrowth" />
            </h3>
            <p className="text-[14px] opacity-70 mb-6 relative z-10 font-sans">
              <T k="x.contributionTrends" />
            </p>
            <div className="flex items-end justify-between h-24 gap-2 relative z-10">
              {[40, 60, 45, 80, 65, 95].map((h, i) => (
                <div
                  key={i}
                  className={`flex-1 bg-dp-secondary-fixed rounded-t-sm ${i === 5 ? 'animate-pulse' : ''}`}
                  style={{ height: `${h}%`, opacity: 0.3 + i * 0.12 }}
                />
              ))}
            </div>
            <div className="flex justify-between mt-2 text-[10px] opacity-60 relative z-10 font-sans">
              {['MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT'].map((m) => (
                <span key={m}>{m}</span>
              ))}
            </div>
            <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-dp-secondary opacity-20 rounded-full blur-3xl" />
          </div>

          {/* Audit Certificate */}
          <div className="bg-dp-surface-container-high p-6 rounded-lg border-s-4 border-dp-primary">
            <div className="flex gap-4">
              <Info size={20} className="text-dp-primary shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-[14px] font-sans"><T k="x.auditCertificate" /></h4>
                <p className="text-[12px] text-dp-on-surface-variant mt-1 leading-relaxed font-sans">
                  All accounts are audited monthly by the Village Finance
                  Sub-Committee. For detailed ledgers from previous years,
                  please visit the main office.
                </p>
                <a
                  href="#"
                  className="inline-block mt-3 text-dp-primary font-bold text-[12px] hover:underline transition-all font-sans"
                >
                  View 2023 Annual Report →
                </a>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
