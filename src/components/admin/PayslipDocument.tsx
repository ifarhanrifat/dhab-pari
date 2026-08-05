'use client'

import { forwardRef } from 'react'
import type { BrandingSettings } from '@/lib/branding'

export interface PayslipJobLine { label: string; amount: number }
export interface PayslipData {
  employeeName: string
  roleEn: string
  month: number
  year: number
  salaryAccrued: number
  overtimeAmount: number
  bonusAmount: number
  emergencyAmount: number
  jobLines: PayslipJobLine[]
  jobTotal: number
  balanceOwed: number
  amountPaidNow: number
  balanceCarriedForward: number
}

interface Props { data: PayslipData; branding: Partial<BrandingSettings> }

function fmt(n: number) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
const monthName = (m: number) => new Date(2000, m - 1, 1).toLocaleString('en', { month: 'long' })

// Plain English/numeric back-office document — matches ReceiptDocument's
// default register, unlike HiringRequestDocument's deliberate Urdu-only
// letterhead (this is an internal payroll record, not a public notice).
// Reflects the ledger-account model: every earning credits the employee's
// own account, every payment debits it — "Balance Owed" is that account's
// live balance, not a computed diff against a settled advance voucher.
export const PayslipDocument = forwardRef<HTMLDivElement, Props>(function PayslipDocument({ data, branding }, ref) {
  const companyNameEn = branding.companyNameEn || 'Dhab Pari'

  return (
    <div ref={ref} className="relative bg-white p-8 w-[560px] font-sans text-dp-on-surface" style={{ fontFamily: 'var(--font-sans), sans-serif' }}>
      <div className="relative text-center mb-4 pb-3 border-b-2 border-dp-primary">
        {branding.logoUrl && (
          <img src={branding.logoUrl} alt="Logo" className="absolute left-0 top-0 object-contain" style={{ width: branding.logoWidth ?? 48, height: branding.logoWidth ?? 48 }} />
        )}
        <p className="text-[18px] font-bold">{companyNameEn}</p>
        <p className="text-[13px] text-dp-on-surface-variant mt-0.5">Payslip / Salary Slip</p>
      </div>

      <div className="flex justify-between items-start mb-5 text-[13px]">
        <div>
          <p className="font-bold text-[15px]">{data.employeeName}</p>
          <p className="text-dp-on-surface-variant">{data.roleEn}</p>
        </div>
        <div className="text-right">
          <p className="text-dp-on-surface-variant">Period</p>
          <p className="font-bold">{monthName(data.month)} {data.year}</p>
        </div>
      </div>

      <p className="text-[12px] font-bold uppercase tracking-wide text-dp-on-surface-variant mb-1.5">Earnings This Cycle</p>
      <table className="w-full text-[13px] mb-4">
        <tbody>
          <Row label="Salary Accrued This Month" amount={data.salaryAccrued} />
          <Row label="Overtime" amount={data.overtimeAmount} />
          <Row label="Eid Bonus" amount={data.bonusAmount} />
          <Row label="Emergency Work Payment" amount={data.emergencyAmount} />
          {data.jobLines.map((j, i) => <Row key={i} label={`Job — ${j.label}`} amount={j.amount} />)}
        </tbody>
      </table>

      <div className="rounded-lg border border-dp-primary/30 bg-dp-primary/5 px-4 py-3 mb-6 space-y-1.5">
        <div className="flex justify-between text-[15px] font-bold text-dp-primary">
          <span>Balance Owed</span><span>Rs. {fmt(data.balanceOwed)}</span>
        </div>
        <div className="flex justify-between text-[13px] border-t border-dp-primary/20 pt-1.5">
          <span>Paid Now</span><span>− Rs. {fmt(data.amountPaidNow)}</span>
        </div>
        <div className="flex justify-between text-[14px] font-bold">
          <span>Balance Carried Forward</span><span>Rs. {fmt(data.balanceCarriedForward)}</span>
        </div>
      </div>

      <div className="flex justify-end mt-10">
        <div className="text-right text-[12px]">
          <div className="w-40 border-t border-dp-outline-variant pt-1">Authorized Signatory</div>
        </div>
      </div>
    </div>
  )
})

function Row({ label, amount }: { label: string; amount: number }) {
  if (amount <= 0) return null
  return (
    <tr className="border-b border-dp-outline-variant">
      <td className="py-1.5">{label}</td>
      <td className="py-1.5 text-right">Rs. {fmt(amount)}</td>
    </tr>
  )
}
