import { Skeleton } from '@/components/skeleton';

export default function PackLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-24" />
      </div>
      <Skeleton className="h-[336px] w-60" />
      <Skeleton className="h-12 w-32" />
    </div>
  );
}
