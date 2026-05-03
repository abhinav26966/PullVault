import { Skeleton } from '@/components/skeleton';

export default function ListingDetailLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-28" />
      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <Skeleton className="h-[380px] w-full" />
        <div className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-48" />
        </div>
      </div>
    </div>
  );
}
