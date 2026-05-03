/**
 * Single primitive used by loading.tsx files to render zinc-200 placeholder
 * blocks while a route segment is server-rendering. animate-pulse is a
 * Tailwind default; no extra config needed.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-zinc-200 animate-pulse rounded-lg ${className}`} />;
}
