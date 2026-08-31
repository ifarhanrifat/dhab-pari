import { Skeleton } from '@/components/ui/Skeleton'

export default function AccountsLoading() {
  return (
    <div className="max-w-[1000px] mx-auto px-4 md:px-6 py-8">
      <Skeleton className="h-10 w-64 mb-2" />
      <Skeleton className="h-5 w-80 mb-6" />
      <Skeleton className="h-12 w-full mb-8" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}
