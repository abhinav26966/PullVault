'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition, type ReactNode } from 'react';

interface Props {
  href: string;
  children: ReactNode;
  className?: string;
  pendingClassName?: string;
}

/**
 * Drop-in replacement for `next/link` that surfaces a per-instance pending
 * state during navigation via React `useTransition`. Browser-default
 * new-tab behavior (cmd/ctrl/shift/middle-click) is preserved by skipping
 * the interception when modifier keys or non-primary buttons are active.
 *
 * Pair with the global `<NavProgress />` indicator for cross-page feedback;
 * this component handles the per-clicked-element cue.
 */
export default function NavLink({
  href,
  children,
  className = '',
  pendingClassName = 'opacity-60 cursor-wait',
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Link
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        startTransition(() => router.push(href));
      }}
      className={`${className}${isPending ? ` ${pendingClassName}` : ''}`}
    >
      {children}
    </Link>
  );
}
