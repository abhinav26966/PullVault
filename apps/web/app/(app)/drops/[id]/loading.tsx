import { Skeleton } from '@/components/skeleton';

export default function DropDetailLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-24" />
      <div className="grid gap-8 md:grid-cols-[240px_1fr]">
        <div className="flex justify-center md:justify-start">
          <Skeleton className="h-[336px] w-60" />
        </div>
        <div className="space-y-6 max-w-xl">
          <div className="space-y-2">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </div>
  );
}
