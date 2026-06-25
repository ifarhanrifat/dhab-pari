import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'
import {
  Wallet,
  FileWarning,
  MessageSquare,
  Heart,
  Lightbulb,
  PlusCircle,
  Newspaper,
  Video,
  Hammer,
  Send,
  Search,
  Filter,
  Pencil,
} from 'lucide-react'

export default async function AdminDashboardPage() {
  const supabase = await createClient()

  const [billsRes, suggestionsRes, donorsRes, projectsRes, consumersRes] = await Promise.all([
    supabase.from('bills').select('id, consumer_id, month, year, amount_pkr, status').order('created_at', { ascending: false }).limit(10),
    supabase.from('suggestions').select('id', { count: 'exact' }).eq('status', 'new'),
    supabase.from('donors').select('id', { count: 'exact' }),
    supabase.from('projects').select('id, title, progress_percent, description, status').eq('is_featured', true).limit(1),
    supabase.from('consumers').select('consumer_id, name, house_no, sector').limit(10),
  ])

  const recentBills = billsRes.data ?? []
  const newSuggestionsCount = suggestionsRes.count ?? 0
  const totalDonorsCount = donorsRes.count ?? 0
  const featuredProject = projectsRes.data?.[0] ?? null
  const consumers = consumersRes.data ?? []

  const unpaidCount = recentBills.filter((b) => b.status === 'unpaid' || b.status === 'late').length

  const consumerMap: Record<string, { name: string; house_no: string | null; sector: string | null }> = {}
  consumers.forEach((c) => { consumerMap[c.consumer_id] = c })

  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })

  return (
    <>
      {/* Welcome Header */}
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-[24px] md:text-[32px] font-bold leading-[32px] md:leading-[40px] text-dp-primary">
            System Overview
          </h1>
          <p className="text-dp-on-surface-variant font-sans text-[16px] mt-1">
            Welcome back, Admin. Village infrastructure is operating normally.
          </p>
        </div>
        <span className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-outline px-3 py-1 border border-dp-outline-variant rounded-full shrink-0">
          Last updated: Today, {timeStr}
        </span>
      </header>

      {/* Pending Suggestions Alert */}
      {newSuggestionsCount > 0 && (
        <div className="mb-8 bg-[#FFF9EB] border-l-4 border-amber-500 p-4 rounded-r-lg flex items-start gap-4">
          <Lightbulb size={20} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <h3 className="font-bold text-amber-900 font-sans text-[16px]">
              Pending Village Suggestions ({newSuggestionsCount})
            </h3>
            <p className="text-amber-800 text-[14px] font-sans font-semibold tracking-[0.05em]">
              Community members have submitted new feedback. Review required.
            </p>
          </div>
          <Link
            href="/admin/settings"
            className="bg-amber-600 text-white px-4 py-2 rounded-lg text-[14px] font-sans font-semibold hover:bg-amber-700 transition-colors shrink-0"
          >
            View All
          </Link>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard icon={<Wallet size={20} />} iconBg="bg-dp-primary-fixed text-dp-primary" badge="+12%" badgeColor="text-dp-secondary" label="Available Funds" value="Rs. 842,500" />
        <StatCard icon={<FileWarning size={20} />} iconBg="bg-dp-error-container text-dp-error" badge="Critical" badgeColor="text-dp-error" label="Unpaid Bills" value={`${unpaidCount} Items`} valueColor="text-dp-error" />
        <StatCard icon={<MessageSquare size={20} />} iconBg="bg-[#FFF9EB] text-amber-600" badge={`${newSuggestionsCount} New`} badgeColor="text-amber-600" label="Pending Suggestions" value={`${newSuggestionsCount} Active`} valueColor="text-amber-800" />
        <StatCard icon={<Heart size={20} />} iconBg="bg-dp-secondary-container text-dp-secondary" badge="+4 this month" badgeColor="text-dp-secondary" label="Total Donors" value={totalDonorsCount.toLocaleString()} />
      </div>

      {/* Quick Actions + Featured Project */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Quick Actions */}
        <div className="lg:col-span-1 bg-white p-6 rounded-lg border border-dp-outline-variant">
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary mb-6 flex items-center gap-2">
            <Lightbulb size={18} /> Quick Actions
          </h3>
          <div className="space-y-3">
            <QuickAction href="/admin/billing" icon={<PlusCircle size={18} />} label="Add New Bill" />
            <QuickAction href="/admin/news" icon={<Newspaper size={18} />} label="Post Village News" />
            <QuickAction href="/admin/videos" icon={<Video size={18} />} label="Upload Progress Video" />
            <QuickAction href="/admin/projects" icon={<Hammer size={18} />} label="Launch Project" />
            <Link
              href="/admin/notifications"
              className="w-full flex items-center justify-between p-3 rounded-lg border border-[#25D366] bg-[#E8FAE9] text-[#075E54] hover:bg-[#25D366] hover:text-white transition-all group"
            >
              <div className="flex items-center gap-3">
                <Send size={18} className="group-hover:text-white" />
                <span className="font-sans text-[16px] font-semibold">WhatsApp Alert</span>
              </div>
            </Link>
          </div>
        </div>

        {/* Featured Project */}
        <div className="lg:col-span-2 relative rounded-lg overflow-hidden min-h-[300px] border border-dp-outline-variant group">
          <div className="absolute inset-0 z-0 bg-gradient-to-br from-dp-primary-container to-dp-tertiary-container" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent z-10" />
          <div className="absolute bottom-0 left-0 p-8 z-20 text-white w-full">
            <div className="flex justify-between items-end">
              <div>
                <h3 className="font-heading text-[24px] md:text-[32px] font-bold leading-[32px] md:leading-[40px] mb-2">
                  {featuredProject?.title ?? 'Main Tank Construction'}
                </h3>
                <p className="font-sans text-[16px] opacity-90">
                  {featuredProject ? `${featuredProject.progress_percent}% complete` : 'Phase 2 completion: 85%.'}
                </p>
              </div>
              <div className="text-right">
                <div className="w-24 bg-white/20 rounded-full h-2 mb-2 overflow-hidden">
                  <div className="bg-dp-secondary-fixed h-full" style={{ width: `${featuredProject?.progress_percent ?? 85}%` }} />
                </div>
                <span className="text-[14px] font-sans font-bold tracking-[0.05em]">
                  {featuredProject?.progress_percent ?? 85}% COMPLETE
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent Billing Table */}
      <section className="bg-white rounded-lg border border-dp-outline-variant overflow-hidden">
        <div className="p-6 border-b border-dp-outline-variant flex flex-col md:flex-row justify-between items-center gap-4">
          <h3 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">
            Recent Billing Activity
          </h3>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <div className="relative flex-1 md:w-64">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-dp-outline" />
              <input
                type="text"
                placeholder="Search Consumer ID/Name..."
                className="w-full pl-10 pr-4 py-2 border-2 border-dp-outline-variant rounded-lg focus:border-dp-primary focus:ring-0 text-[14px] font-sans"
              />
            </div>
            <button className="p-2 border border-dp-outline-variant rounded-lg hover:bg-dp-surface-container transition-colors cursor-pointer">
              <Filter size={18} />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-dp-surface-container-low text-dp-outline text-[14px] font-sans font-bold tracking-[0.05em]">
                <th className="p-4 border-b border-dp-outline-variant">Consumer ID</th>
                <th className="p-4 border-b border-dp-outline-variant">Name</th>
                <th className="p-4 border-b border-dp-outline-variant">House No.</th>
                <th className="p-4 border-b border-dp-outline-variant">Amount</th>
                <th className="p-4 border-b border-dp-outline-variant">Status</th>
                <th className="p-4 border-b border-dp-outline-variant text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="font-sans text-[16px]">
              {recentBills.map((bill, i) => {
                const c = consumerMap[bill.consumer_id]
                return (
                  <tr key={bill.id} className={`hover:bg-dp-surface-container-low transition-colors ${i % 2 === 1 ? 'bg-dp-surface-container-low/30' : ''}`}>
                    <td className="p-4 border-b border-dp-outline-variant font-sans">{bill.consumer_id}</td>
                    <td className="p-4 border-b border-dp-outline-variant font-semibold">{c?.name ?? '—'}</td>
                    <td className="p-4 border-b border-dp-outline-variant">{c?.sector ?? '—'}</td>
                    <td className="p-4 border-b border-dp-outline-variant font-bold">Rs. {Number(bill.amount_pkr).toLocaleString()}</td>
                    <td className="p-4 border-b border-dp-outline-variant">
                      <BillStatusBadge status={bill.status} />
                    </td>
                    <td className="p-4 border-b border-dp-outline-variant text-right space-x-2">
                      {bill.status !== 'paid' ? (
                        <button className="bg-dp-primary text-white px-3 py-1 rounded text-[14px] font-sans font-semibold tracking-[0.05em] hover:bg-dp-primary-container transition-all cursor-pointer">
                          Mark Paid
                        </button>
                      ) : (
                        <button className="opacity-30 cursor-not-allowed border border-dp-outline px-3 py-1 rounded text-[14px] font-sans font-semibold tracking-[0.05em]" disabled>
                          Mark Paid
                        </button>
                      )}
                      <button className="text-dp-primary hover:bg-dp-primary/10 p-1 rounded transition-colors cursor-pointer">
                        <Pencil size={16} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="p-4 flex items-center justify-between bg-dp-surface-container-low">
          <p className="text-[14px] font-sans font-semibold tracking-[0.05em] text-dp-outline">
            Showing 1-{recentBills.length} of consumers
          </p>
          <div className="flex gap-2">
            <button className="px-4 py-2 border border-dp-outline-variant bg-white rounded-lg text-[14px] font-sans hover:bg-dp-surface-container transition-colors disabled:opacity-50 cursor-pointer" disabled>Previous</button>
            <button className="px-4 py-2 border border-dp-outline-variant bg-white rounded-lg text-[14px] font-sans hover:bg-dp-surface-container transition-colors cursor-pointer">Next</button>
          </div>
        </div>
      </section>
    </>
  )
}

function StatCard({ icon, iconBg, badge, badgeColor, label, value, valueColor }: {
  icon: React.ReactNode; iconBg: string; badge: string; badgeColor: string;
  label: string; value: string; valueColor?: string
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-dp-outline-variant flex flex-col justify-between">
      <div className="flex justify-between items-start mb-4">
        <span className={`p-2 rounded-lg ${iconBg}`}>{icon}</span>
        <span className={`font-bold text-[14px] font-sans tracking-[0.05em] ${badgeColor}`}>{badge}</span>
      </div>
      <div>
        <p className="text-dp-outline text-[14px] font-sans font-semibold tracking-[0.05em] uppercase">{label}</p>
        <h4 className={`font-heading text-[32px] font-bold leading-[40px] ${valueColor ?? 'text-dp-primary'}`}>{value}</h4>
      </div>
    </div>
  )
}

function QuickAction({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  return (
    <Link href={href} className="w-full flex items-center justify-between p-3 rounded-lg border border-dp-outline-variant hover:bg-dp-primary-container hover:text-white transition-all group">
      <div className="flex items-center gap-3">
        <span className="text-dp-primary group-hover:text-inherit">{icon}</span>
        <span className="font-sans text-[16px] font-semibold">{label}</span>
      </div>
    </Link>
  )
}

function BillStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    paid: 'bg-dp-primary-container text-white',
    unpaid: 'bg-dp-error-container text-dp-error',
    pending: 'bg-amber-100 text-amber-800',
    late: 'bg-dp-error text-white',
  }
  return (
    <span className={`text-[10px] uppercase font-black px-2 py-1 rounded font-sans ${styles[status] ?? 'bg-dp-surface-container'}`}>
      {status}
    </span>
  )
}
