import { Skeleton } from '@/components/skeleton';

export default function DropDetailLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-32" />
      <div className="max-w-md space-y-4">
        <Skeleton className="h-[336px] w-60" />
        <div className="bg-white border border-zinc-200 rounded p-6 space-y-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
        <Skeleton className="h-12 w-full" />
      </div>
    </div>
  );
}
