import { Skeleton } from '@/components/skeleton';

export default function DropsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i}>
            <Skeleton className="h-44 w-full" />
          </li>
        ))}
      </ul>
    </div>
  );
}
