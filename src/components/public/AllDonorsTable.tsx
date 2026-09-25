'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useLocale } from '@/lib/i18n/LocaleProvider'

interface DonorRow {
  id: string
  name: string | null
  amount_pkr: number
  date: string
  is_anonymous: boolean
  projectTitle: string | null
}

const rankBadges: Record<number, string> = {
  0: 'bg-amber-400',
  1: 'bg-slate-300',
  2: 'bg-orange-300',
}

export function AllDonorsTable({ donors }: { donors: DonorRow[] }) {
  const { t } = useLocale()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return donors
    return donors.filter((d) =>
      (!d.is_anonymous && (d.name ?? '').toLowerCase().includes(q)) ||
      (d.projectTitle ?? '').toLowerCase().includes(q)
    )
  }, [donors, search])

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  return (
    <div>
      <div className="relative mb-6 max-w-md">
        <Search size={16} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-dp-on-surface-variant pointer-events-none" />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder={t('x.searchDonorsPlaceholder')}
          className="w-full ps-10 pe-4 py-2.5 rounded-lg border border-dp-outline-variant font-sans text-[14px] focus:outline-none focus:border-dp-secondary"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-center py-12 text-dp-on-surface-variant font-sans">{t('x.noDonorsMatchSearch')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-dp-outline-variant bg-white">
          <table className="w-full text-start border-collapse">
            <thead className="bg-dp-primary text-white sticky top-0">
              <tr>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">{t('x.rank')}</th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">{t('x.name')}</th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">{t('w.amountPkr')}</th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">{t('w.date')}</th>
                <th className="px-6 py-4 font-sans text-[14px] font-semibold tracking-[0.05em] uppercase">{t('w.project')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dp-outline-variant">
              {filtered.map((donor, i) => (
                <tr key={donor.id} className="hover:bg-dp-surface-container transition-colors">
                  <td className="px-6 py-4">
                    {i < 3 ? (
                      <span className={`w-8 h-8 flex items-center justify-center ${rankBadges[i]} text-white rounded-full font-bold font-sans text-[14px]`}>{i + 1}</span>
                    ) : (
                      <span className="w-8 h-8 flex items-center justify-center text-dp-on-surface-variant font-bold font-sans text-[14px]">{i + 1}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-bold text-dp-primary font-sans">{donor.is_anonymous ? 'Anonymous Donor' : donor.name}</td>
                  <td className="px-6 py-4 font-bold font-sans">{Number(donor.amount_pkr).toLocaleString()}</td>
                  <td className="px-6 py-4 text-dp-on-surface-variant font-sans">{formatDate(donor.date)}</td>
                  <td className="px-6 py-4">
                    {donor.projectTitle ? (
                      <span className="bg-dp-secondary-container/50 text-dp-on-secondary-container px-3 py-1 rounded text-[14px] font-sans font-bold tracking-[0.05em]">{donor.projectTitle}</span>
                    ) : (
                      <span className="bg-dp-surface-container px-3 py-1 rounded text-[14px] font-sans text-dp-on-surface-variant">{t('w.generalFund')}</span>
                    )}
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
