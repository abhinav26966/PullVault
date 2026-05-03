import { Skeleton } from '@/components/skeleton';

export default function AuctionDetailLoading() {
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
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
          <Skeleton className="h-32 w-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
