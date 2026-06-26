import { Skeleton, CardSkeleton, StatCardSkeleton } from '@/components/ui/Skeleton'

export default function HomeLoading() {
  return (
    <>
      <Skeleton className="h-[320px] rounded-none" />
      <div className="max-w-[1200px] mx-auto px-6 -mt-16 relative z-20">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      </div>
      <div className="max-w-[1200px] mx-auto px-6 py-12 flex flex-col lg:flex-row gap-6">
        <div className="flex-1 space-y-12">
          <div>
            <Skeleton className="h-8 w-48 mb-6" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <CardSkeleton />
              <CardSkeleton />
            </div>
          </div>
        </div>
        <div className="w-full lg:w-[280px] space-y-6">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-48 rounded-lg" />
        </div>
      </div>
    </>
  )
}
