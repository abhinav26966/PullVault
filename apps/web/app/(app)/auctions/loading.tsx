import { Skeleton } from '@/components/skeleton';

export default function AuctionsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>
      <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-72" />
          </li>
        ))}
      </ul>
    </div>
  );
}
