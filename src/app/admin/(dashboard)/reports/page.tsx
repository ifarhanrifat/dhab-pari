import { FileText, Download } from 'lucide-react'

export default function AdminReportsPage() {
  return (
    <>
      <h1 className="font-heading text-[32px] font-bold leading-[40px] text-dp-primary mb-8">Reports</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[
          { title: 'Monthly Collection Report', desc: 'Water bill collection summary by sector and status', period: 'June 2024' },
          { title: 'Financial Summary', desc: 'Income vs expenses breakdown with category analysis', period: 'Q2 2024' },
          { title: 'Consumer Activity', desc: 'Active/inactive consumer metrics and connection history', period: 'YTD 2024' },
          { title: 'Project Progress', desc: 'All ongoing and completed projects with budget utilization', period: 'All Time' },
          { title: 'Donor Report', desc: 'Donation trends, top donors, and project-wise allocation', period: '2024' },
          { title: 'Annual Audit Report', desc: 'Complete financial audit with balance sheet and ledger', period: '2023' },
        ].map((report, i) => (
          <div key={i} className="bg-white border border-dp-outline-variant rounded-lg p-6 hover:border-dp-secondary transition-all">
            <div className="flex items-start justify-between mb-3">
              <FileText size={20} className="text-dp-primary shrink-0 mt-1" />
              <span className="text-[12px] font-sans font-semibold tracking-[0.05em] text-dp-on-surface-variant bg-dp-surface-container px-2 py-0.5 rounded">{report.period}</span>
            </div>
            <h3 className="font-sans text-[18px] font-bold text-dp-on-surface mb-1">{report.title}</h3>
            <p className="font-sans text-[14px] text-dp-on-surface-variant mb-4">{report.desc}</p>
            <button className="flex items-center gap-2 text-dp-secondary font-sans text-[14px] font-semibold hover:underline cursor-pointer">
              <Download size={14} /> Download PDF
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
