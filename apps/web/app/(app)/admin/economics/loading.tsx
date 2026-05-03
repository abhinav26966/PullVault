import { Skeleton } from '@/components/skeleton';

export default function EconomicsLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <section className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-44 w-full" />
      </section>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
