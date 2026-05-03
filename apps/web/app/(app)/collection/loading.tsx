import { Skeleton } from '@/components/skeleton';

export default function CollectionLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-3">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
      <ul className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-72" />
          </li>
        ))}
      </ul>
    </div>
  );
}
