import Link from 'next/link'
import { CreditCard, Newspaper } from 'lucide-react'

export function HomeMobileQuickActions() {
  return (
    <section className="md:hidden mx-4 mt-6 bg-dp-secondary-container/30 border border-dp-secondary p-6 rounded-lg">
      <h3 className="font-heading text-[20px] font-bold leading-[28px] text-dp-primary mb-4">
        Quick Actions
      </h3>
      <div className="flex flex-col gap-3">
        <Link
          href="/water"
          className="w-full bg-dp-primary text-white py-4 px-6 rounded-lg font-sans font-semibold text-[18px] flex items-center justify-between active:scale-[0.98] transition-transform"
        >
          <span>Pay Water Bill</span>
          <CreditCard size={20} />
        </Link>
        <Link
          href="/news"
          className="w-full bg-white border-2 border-dp-primary text-dp-primary py-4 px-6 rounded-lg font-sans font-semibold text-[18px] flex items-center justify-between active:scale-[0.98] transition-transform"
        >
          <span>Village News</span>
          <Newspaper size={20} />
        </Link>
      </div>
    </section>
  )
}
