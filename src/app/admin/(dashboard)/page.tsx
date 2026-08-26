import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import {
  Wallet, Landmark, HandCoins, ScrollText, TrendingUp, TrendingDown,
  Users, Heart, Megaphone, PiggyBank, Droplets, HeartHandshake,
  ListFilter, CalendarDays, FileBarChart, Receipt, AlertTriangle, Trophy, Coins,
  UserCheck, UserX, Tag, UserPlus, Banknote,
} from 'lucide-react'
import { IncomeExpenseChart, FundPieChart } from '@/components/admin/DashboardCharts'
import { PendingApprovalsWidget } from '@/components/admin/PendingApprovalsWidget'
import { T } from '@/components/i18n/T'

const systemLabels: Record<string, React.ReactNode> = {
  water_supply: <T k="dash.waterSupplySystem" fallback="Water Supply System" />,
  donors_projects: <T k="dash.donorsProjectsSystem" fallback="Donors & Projects System" />,
}
const creditNormal = (type: string) => type === 'donor' || type === 'income' || type === 'liability'

function fmt(n: number) {
  return Math.round(n).toLocaleString()
}

interface Account { id: string; code: string; name: string; type: string; system: string; opening_balance: number }
interface AccountBalance { account_id: string; total_debit: number; total_credit: number }
interface MonthlyBalance { account_id: string; month: string; total_debit: number; total_credit: number }

export default async function AdminDashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  let role = 'viewer'
  let displayName = 'there'
  let showWater = false
  let showDonor = false
  if (user) {
    // Ask the database the same question its RLS policies ask, instead of
    // re-deriving it from role names here. The hand-rolled version below this
    // comment used to miss secondary_role entirely, so a user whose access came
    // from their second role saw an empty dashboard while every other screen
    // worked.
    const [{ data: profile }, { data: canWater }, { data: canDonor }] = await Promise.all([
      supabase.from('admin_users').select('role, full_name').eq('auth_user_id', user.id).single(),
      supabase.rpc('can_access_system', { p_system: 'water_supply' }),
      supabase.rpc('can_access_system', { p_system: 'donors_projects' }),
    ])
    role = profile?.role ?? 'viewer'
    displayName = profile?.full_name ?? 'there'
    showWater = !!canWater
    showDonor = !!canDonor
  }

  // Computed once, up here, so both the billing-analytics queries below and
  // the header clock further down use the exact same instant.
  const now = new Date()
  const currentMonth = now.getMonth() + 1
  const currentYear = now.getFullYear()

  const monthStartStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`
  const nextMonthStartStr = currentMonth === 12 ? `${currentYear + 1}-01-01` : `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`

  const [{ data: accountsData }, { data: balancesData }, { data: monthlyData }, { data: consumersData }, { data: donorsData }, { data: inventoryData }, { data: topSellingLines }, { data: thisMonthBillsData }, { data: thisMonthPaymentsData }] = await Promise.all([
    supabase.from('accounts').select('id, code, name, type, system, opening_balance'),
    // Aggregated in Postgres (migration 351), not fetched raw and summed in
    // JS — a plain unbounded select on ledger_entries silently truncates at
    // PostgREST's 1000-row default once the ledger grows past that, which
    // is exactly what quietly broke Cash in Hand / Total Expenses here.
    supabase.from('ledger_account_balances').select('account_id, total_debit, total_credit'),
    supabase.from('ledger_monthly_by_account').select('account_id, month, total_debit, total_credit'),
    showWater ? supabase.from('consumers').select('consumer_id, status, created_at') : Promise.resolve({ data: [] as { consumer_id: string; status: string; created_at: string }[] }),
    showDonor ? supabase.from('donors').select('id, amount_pkr, date, is_verified') : Promise.resolve({ data: [] as { id: string; amount_pkr: number; date: string; is_verified: boolean }[] }),
    showWater ? supabase.from('inventory_items').select('id, name, quantity_on_hand, reorder_level').eq('system', 'water_supply').eq('is_active', true) : Promise.resolve({ data: [] as { id: string; name: string; quantity_on_hand: number; reorder_level: number }[] }),
    showWater ? supabase.from('bill_line_items').select('inventory_item_id, description, line_total').eq('item_type', 'inventory') : Promise.resolve({ data: [] as { inventory_item_id: string | null; description: string; line_total: number }[] }),
    // Feeds the billing quick-filter cards below — that whole 6-card grid
    // used to live inline on /admin/billing itself, stacking six-across
    // even on a phone and pushing the actual consumer list below the fold.
    // These cards link to /admin/billing?quickFilter=<value> instead.
    showWater ? supabase.from('bills').select('consumer_id, discount_amount, amount_pkr').eq('month', currentMonth).eq('year', currentYear) : Promise.resolve({ data: [] as { consumer_id: string; discount_amount: number | null; amount_pkr: number }[] }),
    // "Bill Wasooli" (bill collection) — actual cash received this month,
    // distinct from Billed This Month above (what was invoiced, not what
    // came in). Keyed off paid_date, not the bill's own month/year, since a
    // payment collected this month against an older bill is still money
    // collected this month.
    showWater ? supabase.from('payments').select('amount_pkr').gte('paid_date', monthStartStr).lt('paid_date', nextMonthStartStr) : Promise.resolve({ data: [] as { amount_pkr: number }[] }),
  ])

  const accounts: Account[] = accountsData ?? []
  const balances: AccountBalance[] = balancesData ?? []
  const monthly: MonthlyBalance[] = monthlyData ?? []
  const accountMap = Object.fromEntries(accounts.map((a) => [a.id, a]))

  const netByAccount: Record<string, number> = {}
  balances.forEach((b) => { netByAccount[b.account_id] = Number(b.total_debit) - Number(b.total_credit) })

  const balanceOf = (a: Account) => {
    const net = netByAccount[a.id] ?? 0
    return creditNormal(a.type) ? Number(a.opening_balance) - net : Number(a.opening_balance) + net
  }

  function systemStats(system: string) {
    const sysAccounts = accounts.filter((a) => a.system === system)
    const sum = (type: string) => sysAccounts.filter((a) => a.type === type).reduce((s, a) => s + balanceOf(a), 0)
    const cash = sum('cash')
    const bank = sum('bank')
    const income = sum('income')
    const expense = sum('expense')
    const liability = sum('liability')
    const receivable = sysAccounts.filter((a) => a.type === 'consumer').reduce((s, a) => s + Math.max(balanceOf(a), 0), 0)
    return { cash, bank, income, expense, liability, receivable, grossProfit: income, netProfit: income - expense }
  }

  function monthlyTrend(system: string) {
    const months: { key: string; label: string }[] = []
    const now = new Date()
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString('en-US', { month: 'short' }) })
    }
    const buckets: Record<string, { income: number; expense: number }> = {}
    months.forEach((m) => { buckets[m.key] = { income: 0, expense: 0 } })
    monthly.forEach((row) => {
      const acc = accountMap[row.account_id]
      if (!acc || acc.system !== system) return
      const d = new Date(row.month)
      const key = `${d.getFullYear()}-${d.getMonth()}`
      if (!(key in buckets)) return
      if (acc.type === 'income') buckets[key].income += Number(row.total_credit) - Number(row.total_debit)
      else if (acc.type === 'expense') buckets[key].expense += Number(row.total_debit) - Number(row.total_credit)
    })
    return months.map((m) => ({ month: m.label, income: Math.max(0, buckets[m.key].income), expense: Math.max(0, buckets[m.key].expense) }))
  }

  const waterStats = showWater ? systemStats('water_supply') : null
  const donorStats = showDonor ? systemStats('donors_projects') : null
  const waterTrend = showWater ? monthlyTrend('water_supply') : []
  const donorTrend = showDonor ? monthlyTrend('donors_projects') : []

  const activeConsumers = (consumersData ?? []).filter((c) => c.status === 'active').length
  // Same logic as billing/page.tsx's own monthlyStats — card counts reflect
  // distinct consumers, not raw bill rows, so a consumer billed twice this
  // month doesn't inflate the card past what the list it links to shows.
  const inactiveConsumers = (consumersData ?? []).filter((c) => c.status !== 'active').length
  const newConsumersThisMonth = (consumersData ?? []).filter((c) => {
    const d = new Date(c.created_at)
    return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear
  }).length
  const thisMonthBills = thisMonthBillsData ?? []
  const billedThisMonthCount = thisMonthBills.length
  const billedThisMonthTotal = thisMonthBills.reduce((s, b) => s + Number(b.amount_pkr), 0)
  const billWasooliThisMonth = (thisMonthPaymentsData ?? []).reduce((s, p) => s + Number(p.amount_pkr), 0)
  const discountConsumerIds = new Set(thisMonthBills.filter((b) => Number(b.discount_amount ?? 0) > 0).map((b) => b.consumer_id))
  const withDiscountCount = discountConsumerIds.size
  const withDiscountTotal = thisMonthBills.filter((b) => discountConsumerIds.has(b.consumer_id)).reduce((s, b) => s + Number(b.amount_pkr), 0)
  const withoutDiscountCount = (consumersData ?? []).filter((c) => !discountConsumerIds.has(c.consumer_id)).length
  const lowStockItems = (inventoryData ?? []).filter((i) => i.reorder_level > 0 && i.quantity_on_hand <= i.reorder_level)
  const revenueByItem: Record<string, { name: string; revenue: number }> = {}
  for (const r of topSellingLines ?? []) {
    if (!r.inventory_item_id) continue
    const cur = revenueByItem[r.inventory_item_id] ?? { name: r.description, revenue: 0 }
    cur.revenue += Number(r.line_total)
    revenueByItem[r.inventory_item_id] = cur
  }
  const topSellingItem = Object.values(revenueByItem).sort((a, b) => b.revenue - a.revenue)[0] ?? null
  const collectorHoldings = accounts.filter((a) => a.type === 'collector' && a.system === 'water_supply').reduce((s, a) => s + Math.max(balanceOf(a), 0), 0)
  const donorPartyCount = accounts.filter((a) => a.system === 'donors_projects' && a.type === 'donor').length
  // "Announced" is deliberately every donation record regardless of state —
  // same vocabulary as the receipt's own "announced but not yet collected"
  // row. "Received" is a real money figure and must be verified-only, same
  // as the Reports page's Donor Report and the public homepage_stats() —
  // an unconfirmed/pledged donation hasn't posted to the ledger yet
  // (trg_donor_ledger), so counting it here disagreed with the ledger-
  // derived Cash in Hand shown right next to it on this same page.
  const donationsAnnounced = (donorsData ?? []).length
  const donationsReceived = (donorsData ?? []).filter((d) => d.is_verified).reduce((s, d) => s + Number(d.amount_pkr), 0)

  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <>
      {/* rtl-header-row swaps the name block and the clock badge under Urdu
          (see globals.css — applies at every width now, not just md: and
          up, so the same-row + mirrored positioning holds on a phone too,
          not just desktop). Just the name, no "Welcome back," preamble —
          this reads as an identity bar now, not a greeting. */}
      <header className="rtl-header-row mb-8 flex flex-row items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="rtl-text font-heading text-[20px] md:text-[32px] font-bold leading-[26px] md:leading-[40px] text-dp-primary truncate">
            {displayName}
          </h1>
        </div>
        <span className="text-[11px] md:text-[13px] font-sans font-semibold tracking-[0.05em] text-dp-outline px-2.5 md:px-3 py-1 border border-dp-outline-variant rounded-full shrink-0 whitespace-nowrap">
          {dateStr}, {timeStr}
        </span>
      </header>

      <PendingApprovalsWidget />

      {!showWater && !showDonor && (
        <div className="bg-white rounded-lg border border-dp-outline-variant p-12 text-center font-sans text-dp-on-surface-variant">
          <T k="dash.noAccess" fallback="You don't have access to any system's data yet. Contact an administrator." />
        </div>
      )}

      {showWater && waterStats && (
        <SystemSection
          title={systemLabels.water_supply}
          icon={<Droplets size={22} />}
          accentClass="text-blue-700"
        >
          <DashboardQuickButtons items={[
            { href: '/admin/billing', icon: <Receipt size={16} className="shrink-0" />, labelKey: 'nav.billing', labelFallback: 'Billing' },
            { href: '/admin/transactions?system=water_supply', icon: <ListFilter size={16} className="shrink-0" />, labelKey: 'dash.allTransactions', labelFallback: 'All Transactions' },
            { href: '/admin/reports?system=water_supply', icon: <FileBarChart size={16} className="shrink-0" />, labelKey: 'dash.reports', labelFallback: 'Reports' },
            { href: '/admin/register?system=water_supply', icon: <CalendarDays size={16} className="shrink-0" />, labelKey: 'dash.dailyRegister', labelFallback: 'Daily Register' },
          ]} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
            <StatCard href="/admin/accounts/by-type?system=water_supply&type=cash" icon={<Wallet size={19} />} color="teal" label={<T k="dash.cashInHand" fallback="Cash in Hand" />} value={`Rs. ${fmt(waterStats.cash)}`} />
            <StatCard href="/admin/accounts/by-type?system=water_supply&type=bank" icon={<Landmark size={19} />} color="blue" label={<T k="dash.cashInBank" fallback="Cash in Bank" />} value={`Rs. ${fmt(waterStats.bank)}`} />
            <StatCard href="/admin/register?system=water_supply" icon={<Banknote size={19} />} color="emerald" label={<T k="dash.billWasooliThisMonth" fallback="Bill Wasooli This Month" />} value={`Rs. ${fmt(billWasooliThisMonth)}`} />
            <StatCard href="/admin/reports?report=consumer_outstanding&system=water_supply" icon={<HandCoins size={19} />} color="amber" label={<T k="dash.totalReceivable" fallback="Total Receivable" />} value={`Rs. ${fmt(waterStats.receivable)}`} />
            <StatCard href="/admin/accounts/by-type?system=water_supply&type=liability" icon={<ScrollText size={19} />} color="rose" label={<T k="dash.totalPayable" fallback="Total Payable" />} value={`Rs. ${fmt(waterStats.liability)}`} />
            <StatCard href="/admin/reports?report=income_expense&system=water_supply" icon={<TrendingUp size={19} />} color="emerald" label={<T k="dash.grossIncome" fallback="Gross Income" />} value={`Rs. ${fmt(waterStats.grossProfit)}`} />
            <StatCard href="/admin/accounts/by-type?system=water_supply&type=expense" icon={<TrendingDown size={19} />} color="red" label={<T k="dash.totalExpenses" fallback="Total Expenses" />} value={`Rs. ${fmt(waterStats.expense)}`} />
            <StatCard href="/admin/reports?report=income_expense&system=water_supply" icon={waterStats.netProfit >= 0 ? <TrendingUp size={19} /> : <TrendingDown size={19} />} color={waterStats.netProfit >= 0 ? 'emerald' : 'red'} label={<T k="dash.netProfit" fallback="Net Profit" />} value={`Rs. ${fmt(waterStats.netProfit)}`} />
            <StatCard href="/admin/billing" icon={<Users size={19} />} color="violet" label={<T k="dash.totalConsumers" fallback="Total Consumers" />} value={activeConsumers.toLocaleString()} />
            <StatCard href="/admin/inventory?tab=analytics" icon={<AlertTriangle size={19} />} color={lowStockItems.length > 0 ? 'red' : 'teal'} label={<T k="dash.lowStockItems" fallback="Low Stock Items" />} value={lowStockItems.length.toLocaleString()} />
            <StatCard href="/admin/inventory?tab=analytics" icon={<Trophy size={19} />} color="amber" label={<T k="dash.topSellingItem" fallback="Top Selling Item" />} value={topSellingItem ? topSellingItem.name : <T k="dash.noSalesYet" fallback="No sales yet" />} />
            <StatCard href="/admin/collectors" icon={<Coins size={19} />} color={collectorHoldings > 0 ? 'red' : 'teal'} label={<T k="dash.collectorHoldings" fallback="Collector Holdings" />} value={`Rs. ${fmt(collectorHoldings)}`} />
            {/* Moved from a 6-card row that used to live inline on the
                Billing page itself — on a phone it stacked into a wall of
                cards above the actual consumer list. Each links straight
                to Billing with that filter already applied
                (?quickFilter=<value>, read on mount there). */}
            <StatCard href="/admin/billing?quickFilter=billed_this_month" icon={<Receipt size={19} />} color="teal" label={<T k="dash.billedThisMonth" fallback="Billed This Month" />} value={`Rs. ${fmt(billedThisMonthTotal)}`} />
            <StatCard href="/admin/billing?quickFilter=active" icon={<UserCheck size={19} />} color="emerald" label={<T k="dash.activeConnections" fallback="Active Connections" />} value={activeConsumers.toLocaleString()} />
            <StatCard href="/admin/billing?quickFilter=inactive" icon={<UserX size={19} />} color="red" label={<T k="dash.deactivated" fallback="Deactivated" />} value={inactiveConsumers.toLocaleString()} />
            <StatCard href="/admin/billing?quickFilter=with_discount" icon={<Tag size={19} />} color="amber" label={<T k="dash.withDiscount" fallback="With Discount" />} value={withDiscountCount.toLocaleString()} />
            <StatCard href="/admin/billing?quickFilter=without_discount" icon={<Users size={19} />} color="blue" label={<T k="dash.withoutDiscount" fallback="Without Discount" />} value={withoutDiscountCount.toLocaleString()} />
            <StatCard href="/admin/billing?quickFilter=new_this_month" icon={<UserPlus size={19} />} color="violet" label={<T k="dash.newThisMonth" fallback="New This Month" />} value={newConsumersThisMonth.toLocaleString()} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white rounded-lg border border-dp-outline-variant p-5">
              <h3 className="rtl-text font-sans text-[15px] font-bold text-dp-on-surface mb-2"><T k="y.incomeVsExpense" /></h3>
              <IncomeExpenseChart data={waterTrend} />
            </div>
            <div className="bg-white rounded-lg border border-dp-outline-variant p-5">
              <h3 className="rtl-text font-sans text-[15px] font-bold text-dp-on-surface mb-2"><T k="y.fundPosition" /></h3>
              <FundPieChart data={[{ name: 'Cash', value: Math.max(waterStats.cash, 0) }, { name: 'Bank', value: Math.max(waterStats.bank, 0) }, { name: 'Receivable', value: Math.max(waterStats.receivable, 0) }]} />
            </div>
          </div>
        </SystemSection>
      )}

      {showDonor && donorStats && (
        <SystemSection
          title={systemLabels.donors_projects}
          icon={<HeartHandshake size={22} />}
          accentClass="text-violet-700"
        >
          <DashboardQuickButtons items={[
            { href: '/admin/donors', icon: <Heart size={16} className="shrink-0" />, labelKey: 'nav.donors', labelFallback: 'Donors' },
            { href: '/admin/transactions?system=donors_projects', icon: <ListFilter size={16} className="shrink-0" />, labelKey: 'dash.allTransactions', labelFallback: 'All Transactions' },
            { href: '/admin/reports?system=donors_projects', icon: <FileBarChart size={16} className="shrink-0" />, labelKey: 'dash.reports', labelFallback: 'Reports' },
            { href: '/admin/register?system=donors_projects', icon: <CalendarDays size={16} className="shrink-0" />, labelKey: 'dash.dailyRegister', labelFallback: 'Daily Register' },
          ]} />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
            <StatCard href="/admin/accounts/by-type?system=donors_projects&type=cash" icon={<Wallet size={19} />} color="teal" label={<T k="dash.cashInHand" fallback="Cash in Hand" />} value={`Rs. ${fmt(donorStats.cash)}`} />
            <StatCard href="/admin/accounts/by-type?system=donors_projects&type=bank" icon={<Landmark size={19} />} color="blue" label={<T k="dash.cashInBank" fallback="Cash in Bank" />} value={`Rs. ${fmt(donorStats.bank)}`} />
            <StatCard href="/admin/donors" icon={<Heart size={19} />} color="pink" label={<T k="dash.totalDonors" fallback="Total Donors" />} value={donorPartyCount.toLocaleString()} />
            <StatCard href="/admin/accounts/by-type?system=donors_projects&type=liability" icon={<ScrollText size={19} />} color="rose" label={<T k="dash.totalPayable" fallback="Total Payable" />} value={`Rs. ${fmt(donorStats.liability)}`} />
            <StatCard href="/admin/donors" icon={<Megaphone size={19} />} color="amber" label={<T k="dash.donationsAnnounced" fallback="Donations Announced" />} value={donationsAnnounced.toLocaleString()} />
            <StatCard href="/admin/donors" icon={<PiggyBank size={19} />} color="emerald" label={<T k="dash.donationsReceived" fallback="Donations Received" />} value={`Rs. ${fmt(donationsReceived)}`} />
            <StatCard href="/admin/accounts/by-type?system=donors_projects&type=expense" icon={<TrendingDown size={19} />} color="red" label={<T k="dash.totalExpenses" fallback="Total Expenses" />} value={`Rs. ${fmt(donorStats.expense)}`} />
            <StatCard href="/admin/reports?report=income_expense&system=donors_projects" icon={donorStats.netProfit >= 0 ? <TrendingUp size={19} /> : <TrendingDown size={19} />} color={donorStats.netProfit >= 0 ? 'emerald' : 'red'} label={<T k="dash.netProfit" fallback="Net Profit" />} value={`Rs. ${fmt(donorStats.netProfit)}`} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 bg-white rounded-lg border border-dp-outline-variant p-5">
              <h3 className="rtl-text font-sans text-[15px] font-bold text-dp-on-surface mb-2"><T k="y.incomeVsExpense" /></h3>
              <IncomeExpenseChart data={donorTrend} incomeColor="#7c3aed" expenseColor="#dc2626" />
            </div>
            <div className="bg-white rounded-lg border border-dp-outline-variant p-5">
              <h3 className="rtl-text font-sans text-[15px] font-bold text-dp-on-surface mb-2"><T k="y.fundPosition" /></h3>
              <FundPieChart data={[{ name: 'Cash', value: Math.max(donorStats.cash, 0) }, { name: 'Bank', value: Math.max(donorStats.bank, 0) }]} />
            </div>
          </div>
        </SystemSection>
      )}
    </>
  )
}

const colorStyles: Record<string, string> = {
  teal: 'bg-teal-100 text-teal-700',
  blue: 'bg-blue-100 text-blue-700',
  amber: 'bg-amber-100 text-amber-700',
  rose: 'bg-rose-100 text-rose-700',
  emerald: 'bg-emerald-100 text-emerald-700',
  red: 'bg-red-100 text-red-700',
  violet: 'bg-violet-100 text-violet-700',
  pink: 'bg-pink-100 text-pink-700',
}

function StatCard({ href, icon, color, label, value }: {
  href: string; icon: React.ReactNode; color: string; label: React.ReactNode; value: React.ReactNode
}) {
  return (
    <Link href={href} title={typeof value === 'string' ? value : undefined} className="bg-white p-3 sm:p-5 rounded-lg border border-dp-outline-variant flex flex-col justify-between hover:shadow-md hover:border-dp-primary/30 transition-all group">
      <div className="flex justify-between items-start mb-2 sm:mb-3">
        <span className={`p-2 rounded-lg ${colorStyles[color]}`}>{icon}</span>
      </div>
      <div>
        <p className="rtl-text text-dp-on-surface-variant text-[11px] sm:text-[12px] font-sans font-semibold tracking-[0.05em] uppercase leading-tight">{label}</p>
        <h4 className="rtl-text font-heading text-[18px] sm:text-[22px] font-bold leading-[24px] sm:leading-[30px] text-dp-on-surface group-hover:text-dp-primary transition-colors truncate">{value}</h4>
      </div>
    </Link>
  )
}

// The four day-to-day entry points someone opens this dashboard to reach,
// pinned to one row above the stat grid instead of freely wrapping below it.
// Fixed-width flex-1 cells plus a shrinking type scale keep the longest
// label ("All Transactions") from wrapping or overflowing at 360px.
//
// paddingTop/paddingBottom are set inline, not via py-* utility classes:
// globals.css's html[lang='ur'] a { padding-bottom: 0.15em } (the Nastaliq
// descender fix) is a plain, un-layered rule, and Tailwind v4's utilities
// all live inside its own @layer — an un-layered rule always beats a
// layered one regardless of specificity, so any py-* class here was
// silently losing its bottom half in Urdu mode no matter how generous it
// was. An inline style wins over both.
function DashboardQuickButtons({ items }: {
  items: { href: string; icon: React.ReactNode; labelKey: string; labelFallback: string }[]
}) {
  return (
    <div className="rtl-icon-row flex gap-1.5 sm:gap-2.5 mb-5">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          style={{ paddingTop: '0.625rem', paddingBottom: '0.625rem' }}
          className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 px-1 bg-white border border-dp-outline-variant rounded-lg font-sans text-dp-on-surface-variant hover:text-dp-primary hover:border-dp-primary/30 hover:shadow-sm transition-all"
        >
          {item.icon}
          <span className="text-[10px] sm:text-[12.5px] font-semibold text-center leading-tight whitespace-nowrap"><T k={item.labelKey} fallback={item.labelFallback} /></span>
        </Link>
      ))}
    </div>
  )
}

function SystemSection({ title, icon, accentClass, children }: {
  title: React.ReactNode; icon: React.ReactNode; accentClass: string; children: React.ReactNode
}) {
  return (
    <section className="mb-10">
      <h2 className={`rtl-icon-row font-heading text-[20px] font-bold mb-4 flex items-center gap-2 ${accentClass}`}>
        {icon} {title}
      </h2>
      {children}
    </section>
  )
}
