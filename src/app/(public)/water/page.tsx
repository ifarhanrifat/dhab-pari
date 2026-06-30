'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { SITE } from '@/lib/constants'
import Link from 'next/link'
import {
  Search,
  AlertTriangle,
  Building2,
  MapPin,
  Phone,
  Mail,
  Download,
} from 'lucide-react'

interface Consumer {
  consumer_id: string
  name: string
  name_ur: string | null
  address: string | null
  house_no: string | null
  sector: string | null
  area: string | null
}

interface Bill {
  id: string
  month: number
  year: number
  amount_pkr: number
  status: string
  paid_date: string | null
}

const monthNames = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export default function WaterBillPage() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [consumer, setConsumer] = useState<Consumer | null>(null)
  const [bills, setBills] = useState<Bill[]>([])
  const [error, setError] = useState('')

  const supabase = createClient()

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = query.trim().toUpperCase()
    if (!trimmed) return

    setLoading(true)
    setError('')
    setConsumer(null)
    setBills([])

    // Search by lookup_token (secure random code) or consumer_id
    let consumerData = null
    let consumerErr = null

    const { data: byToken, error: errToken } = await supabase
      .from('consumers')
      .select('consumer_id, name, name_ur, address, house_no, sector, area')
      .eq('lookup_token', trimmed)
      .single()

    if (byToken) {
      consumerData = byToken
    } else {
      const { data: byId, error: errId } = await supabase
        .from('consumers')
        .select('consumer_id, name, name_ur, address, house_no, sector, area')
        .eq('consumer_id', trimmed)
        .single()
      consumerData = byId
      consumerErr = errId
    }

    if (!consumerData) {
      setError('Consumer not found. Please check your code and try again.')
      setSearched(true)
      setLoading(false)
      return
    }

    setConsumer(consumerData)

    const { data: billsData } = await supabase
      .from('bills')
      .select('id, month, year, amount_pkr, status, paid_date')
      .eq('consumer_id', consumerData.consumer_id)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(6)

    setBills(billsData ?? [])
    setSearched(true)
    setLoading(false)
  }

  const latestBill = bills[0] ?? null
  const totalOutstanding = bills
    .filter((b) => b.status === 'unpaid' || b.status === 'late')
    .reduce((sum, b) => sum + b.amount_pkr, 0)
  const hasUnpaidBills = totalOutstanding > 0

  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-8 flex flex-col md:flex-row gap-8">

      {/* ===== LEFT: Main Content ===== */}
      <div className="flex-1 space-y-8">

        {/* Page Title */}
        <div className="space-y-2">
          <h1 className="font-heading text-[24px] md:text-[32px] font-bold leading-[32px] md:leading-[40px] text-dp-primary section-title">
            Water Bill Lookup ·{' '}
            <span
              className="text-[24px]"
              style={{ fontFamily: 'var(--font-urdu), serif', lineHeight: '2.5' }}
            >
              پانی کا بل چیک کریں
            </span>
          </h1>
          <p className="text-dp-on-surface-variant font-sans text-[16px] leading-[24px]">
            Enter your Consumer ID to view your current status and payment history.
          </p>
        </div>

        {/* Search Card */}
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 md:p-8 shadow-sm">
          <form onSubmit={handleSearch} className="space-y-6">
            <div>
              <label
                htmlFor="consumer_id"
                className="block font-sans text-[14px] font-semibold tracking-[0.05em] text-dp-on-surface-variant mb-2"
              >
                CONSUMER ID / کنزیومر آئی ڈی
              </label>
              <div className="relative">
                <Search
                  size={18}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-dp-outline"
                />
                <input
                  id="consumer_id"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="e.g. A3F8BC12 or DP-1001"
                  className="w-full pl-12 pr-4 py-4 bg-white border-2 border-dp-outline-variant rounded-lg focus:border-dp-secondary focus:ring-0 transition-all font-sans text-[18px] leading-[28px] text-dp-on-surface"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-dp-secondary text-white py-4 rounded-lg font-sans text-[20px] font-semibold leading-[28px] hover:bg-dp-primary transition-all active:scale-[0.98] flex justify-center items-center gap-3 disabled:opacity-50"
            >
              {loading ? 'Searching...' : 'Check Bill Status / بل چیک کریں'}
            </button>
          </form>
        </div>

        {/* Error State */}
        {searched && error && (
          <div className="bg-dp-error-container text-dp-on-error-container px-6 py-4 rounded-lg font-sans text-[16px]">
            {error}
          </div>
        )}

        {/* Results */}
        {consumer && (
          <div className="space-y-8">

            {/* Consumer Info + Status Badge */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between bg-dp-surface-container-low border border-dp-outline-variant rounded-lg p-6">
              <div className="space-y-1">
                <h2 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-on-surface">
                  Consumer: {consumer.name}
                </h2>
                <p className="text-dp-on-surface-variant font-sans text-[16px]">
                  {consumer.address && `${consumer.address}`}
                  {consumer.area && `, ${consumer.area}`}
                </p>
                {latestBill && (
                  <p className="text-dp-on-surface-variant font-sans text-[16px]">
                    Billing Month:{' '}
                    <span className="font-bold">
                      {monthNames[latestBill.month]} {latestBill.year}
                    </span>
                  </p>
                )}
              </div>
              {latestBill && (
                <div className="mt-4 md:mt-0">
                  {latestBill.status === 'paid' && (
                    <div className="flex items-center gap-2 bg-dp-primary text-white px-6 py-3 rounded-full font-bold font-sans text-[14px]">
                      PAID ✓{' '}
                      <span style={{ fontFamily: 'var(--font-urdu), serif' }}>
                        ادا شدہ
                      </span>
                    </div>
                  )}
                  {(latestBill.status === 'unpaid' || latestBill.status === 'late') && (
                    <div className="flex items-center gap-2 bg-dp-error text-white px-6 py-3 rounded-full font-bold font-sans text-[14px]">
                      UNPAID{' '}
                      <span style={{ fontFamily: 'var(--font-urdu), serif' }}>
                        غیر ادا شدہ
                      </span>
                    </div>
                  )}
                  {latestBill.status === 'pending' && (
                    <div className="flex items-center gap-2 bg-amber-100 text-amber-800 px-6 py-3 rounded-full font-bold font-sans text-[14px]">
                      PENDING{' '}
                      <span style={{ fontFamily: 'var(--font-urdu), serif' }}>
                        زیر التواء
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Unpaid Warning */}
            {hasUnpaidBills && (
              <div className="bg-amber-50 border-l-4 border-amber-500 p-6 rounded-r-lg flex flex-col md:flex-row gap-6">
                <div className="shrink-0 text-amber-600">
                  <AlertTriangle size={48} />
                </div>
                <div className="space-y-4">
                  <div>
                    <h3 className="font-sans text-[20px] font-semibold leading-[28px] text-amber-900">
                      Immediate Payment Required
                    </h3>
                    <p className="text-amber-800 font-sans text-[16px]">
                      Total Outstanding:{' '}
                      <span className="font-bold text-[18px]">
                        Rs. {totalOutstanding.toLocaleString()}
                      </span>
                      . Please clear your bill through the following methods to
                      avoid reconnection charges.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded border border-amber-200 flex items-center gap-4">
                      <div className="w-12 h-12 bg-gray-100 rounded flex items-center justify-center font-bold text-[10px] text-center font-sans leading-tight">
                        Jazz
                        <br />
                        Cash
                      </div>
                      <div>
                        <p className="font-sans text-[14px] font-semibold tracking-[0.05em]">
                          JazzCash
                        </p>
                        <p className="font-bold text-dp-primary font-sans">
                          {SITE.jazzcash}
                        </p>
                      </div>
                    </div>
                    <div className="bg-white p-4 rounded border border-amber-200 flex items-center gap-4">
                      <div className="w-12 h-12 bg-gray-100 rounded flex items-center justify-center font-bold text-[10px] text-center font-sans leading-tight">
                        Easy
                        <br />
                        Paisa
                      </div>
                      <div>
                        <p className="font-sans text-[14px] font-semibold tracking-[0.05em]">
                          Easypaisa
                        </p>
                        <p className="font-bold text-dp-primary font-sans">
                          {SITE.easypaisa}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Billing History Table */}
            <div className="space-y-4">
              <h3 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary">
                Billing History /{' '}
                <span style={{ fontFamily: 'var(--font-urdu), serif' }}>
                  بل کی تاریخ
                </span>
              </h3>
              <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden shadow-sm">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-dp-surface-container text-dp-on-surface font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">
                      <th className="px-6 py-4 border-b border-dp-outline-variant">
                        Month/Year
                      </th>
                      <th className="px-6 py-4 border-b border-dp-outline-variant">
                        Amount
                      </th>
                      <th className="px-6 py-4 border-b border-dp-outline-variant">
                        Status
                      </th>
                      <th className="px-6 py-4 border-b border-dp-outline-variant text-right">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dp-outline-variant">
                    {bills.map((bill, i) => (
                      <tr
                        key={bill.id}
                        className={`hover:bg-dp-surface-container-low transition-colors ${
                          i % 2 === 1 ? 'bg-dp-surface-container-low' : ''
                        }`}
                      >
                        <td className="px-6 py-4 font-sans text-[16px]">
                          {monthNames[bill.month]} {bill.year}
                        </td>
                        <td className="px-6 py-4 font-sans text-[16px]">
                          Rs. {bill.amount_pkr.toLocaleString()}
                        </td>
                        <td className="px-6 py-4">
                          <StatusBadge status={bill.status} />
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button className="text-dp-secondary font-sans text-[14px] font-semibold tracking-[0.05em] hover:underline inline-flex items-center gap-1 cursor-pointer">
                            <Download size={14} />
                            Download PDF
                          </button>
                        </td>
                      </tr>
                    ))}
                    {bills.length === 0 && (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-6 py-8 text-center text-dp-on-surface-variant font-sans"
                        >
                          No billing history found.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== RIGHT: Sidebar ===== */}
      <aside className="w-full md:w-80 space-y-6 shrink-0">

        {/* How to Pay */}
        <div className="bg-white border border-dp-outline-variant rounded-lg p-6 shadow-sm">
          <h4 className="font-sans text-[20px] font-semibold leading-[28px] text-dp-primary mb-4 flex items-center gap-2">
            <Building2 size={20} className="text-dp-secondary" />
            How to Pay?
          </h4>
          <div className="space-y-4 font-sans text-dp-on-surface-variant text-[16px]">
            <div className="flex gap-3">
              <Building2 size={20} className="text-dp-secondary shrink-0 mt-0.5" />
              <p>
                <span className="font-bold">Bank Transfer:</span> {SITE.bankName},{' '}
                {SITE.bankBranch}, Acc: {SITE.bankAccount}
              </p>
            </div>
            <div className="flex gap-3">
              <MapPin size={20} className="text-dp-secondary shrink-0 mt-0.5" />
              <p>
                <span className="font-bold">Walk-in:</span> Visit Welfare Office
                near Central Mosque from 9 AM to 2 PM.
              </p>
            </div>
          </div>
        </div>

        {/* New Connection */}
        <div className="bg-dp-primary-container text-dp-on-primary-container rounded-lg p-6 shadow-sm overflow-hidden relative">
          <div
            className="absolute inset-0 opacity-10 pointer-events-none"
            style={{
              backgroundImage: 'radial-gradient(#83c1ad 2px, transparent 2px)',
              backgroundSize: '20px 20px',
            }}
          />
          <h4 className="font-sans text-[20px] font-semibold leading-[28px] mb-2 relative z-10">
            New Connection?
          </h4>
          <p className="font-sans text-[16px] mb-6 opacity-90 relative z-10">
            Apply online for a new water connection for your home or shop.
          </p>
          <Link
            href="/water/apply"
            className="block w-full text-center bg-dp-secondary-container text-dp-on-secondary-container py-3 rounded-lg font-bold font-sans hover:bg-dp-secondary-fixed transition-colors active:scale-95 relative z-10"
          >
            Submit Application
          </Link>
        </div>

        {/* Help Contact */}
        <div className="bg-dp-surface-container-high rounded-lg p-6">
          <h4 className="font-sans text-[14px] font-semibold tracking-[0.05em] uppercase text-dp-on-surface mb-3">
            Need Help?
          </h4>
          <div className="space-y-3">
            <a
              href={`tel:${SITE.whatsapp.replace(/-/g, '')}`}
              className="flex items-center gap-3 text-dp-secondary hover:underline font-sans"
            >
              <Phone size={18} />
              {SITE.whatsapp}
            </a>
            <a
              href={`mailto:${SITE.email}`}
              className="flex items-center gap-3 text-dp-secondary hover:underline font-sans"
            >
              <Mail size={18} />
              {SITE.email}
            </a>
          </div>
        </div>
      </aside>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'paid':
      return (
        <span className="bg-dp-primary text-white text-[12px] px-3 py-1 rounded-full font-bold font-sans uppercase">
          PAID
        </span>
      )
    case 'unpaid':
      return (
        <span className="bg-dp-error-container text-dp-error text-[12px] px-3 py-1 rounded-full font-bold font-sans uppercase">
          UNPAID
        </span>
      )
    case 'late':
      return (
        <span className="bg-dp-error text-white text-[12px] px-3 py-1 rounded-full font-bold font-sans uppercase">
          LATE
        </span>
      )
    case 'pending':
      return (
        <span className="bg-amber-100 text-amber-800 text-[12px] px-3 py-1 rounded-full font-bold font-sans uppercase">
          PENDING
        </span>
      )
    default:
      return (
        <span className="bg-dp-surface-container text-dp-on-surface-variant text-[12px] px-3 py-1 rounded-full font-bold font-sans uppercase">
          {status}
        </span>
      )
  }
}
