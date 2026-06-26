import { Skeleton } from '@/components/ui/Skeleton'

export default function DonateLoading() {
  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-10 py-12">
      <div className="text-center mb-16">
        <Skeleton className="h-12 w-12 rounded-full mx-auto mb-4" />
        <Skeleton className="h-8 w-64 mx-auto mb-6" />
        <Skeleton className="h-16 w-96 mx-auto" />
      </div>
      <Skeleton className="h-6 w-48 mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-20">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-72" />
        ))}
      </div>
    </div>
  )
}
