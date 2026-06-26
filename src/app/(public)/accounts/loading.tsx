import { Skeleton, StatCardSkeleton, TableSkeleton } from '@/components/ui/Skeleton'

export default function AccountsLoading() {
  return (
    <div className="max-w-[1200px] mx-auto px-4 md:px-6 py-8">
      <Skeleton className="h-10 w-64 mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
      <TableSkeleton rows={6} />
    </div>
  )
}
