export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-dp-surface-container-high rounded-lg ${className}`} />
}

export function CardSkeleton() {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
      <Skeleton className="h-48 rounded-none" />
      <div className="p-6 space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-2 w-full" />
        <div className="flex justify-between pt-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  )
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="bg-white border border-dp-outline-variant rounded-lg overflow-hidden">
      <div className="p-6 border-b border-dp-outline-variant">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="p-4 space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  )
}

export function StatCardSkeleton() {
  return (
    <div className="bg-white border border-dp-outline-variant p-6 rounded-lg">
      <div className="flex justify-between mb-4">
        <Skeleton className="h-10 w-10 rounded-lg" />
        <Skeleton className="h-5 w-12" />
      </div>
      <Skeleton className="h-4 w-24 mb-2" />
      <Skeleton className="h-8 w-32" />
    </div>
  )
}
