'use client';

import { usePathname } from 'next/navigation';

/**
 * Top-of-screen progress bar. The CSS animation defined in globals.css
 * runs once whenever this element mounts; passing `key={pathname}` forces
 * React to unmount + remount on every route change, which restarts the
 * animation. No JS animation library, no router event listener — just
 * pathname-keyed remount + a CSS keyframe.
 */
export default function NavProgress() {
  const pathname = usePathname();
  return (
    <div
      key={pathname}
      className="fixed top-0 left-0 h-0.5 bg-blue-600 z-50 animate-nav-progress pointer-events-none"
    />
  );
}
