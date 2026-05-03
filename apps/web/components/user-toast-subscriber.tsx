'use client';

import { usePathname } from 'next/navigation';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Global subscriber to `user:{userId}` events. Fires toasts for events the
 * user should know about regardless of which page they're on. Mounted once
 * in the (app) layout. The auction room's inline outbid banner handles the
 * case where the user is viewing the SAME auction; this subscriber only
 * toasts for events on OTHER auctions/listings via the pathname check.
 */
export default function UserToastSubscriber({ userId }: { userId: string }) {
  const pathname = usePathname();

  useChannel(`user:${userId}`, {
    onEvent: (payload) => {
      const ev = (payload as { event?: string }).event;
      const auctionId = (payload as { auctionId?: unknown }).auctionId;
      const finalBid = (payload as { finalBid?: unknown }).finalBid;
      const netCents = (payload as { netCents?: unknown }).netCents;
      const priceCents = (payload as { priceCents?: unknown }).priceCents;

      if (ev === 'outbid' && typeof auctionId === 'string') {
        if (pathname === `/auctions/${auctionId}`) return;
        toast('⚠ You’ve been outbid — return to the auction to bid again', {
          icon: '⚠️',
        });
      } else if (ev === 'auction_won' && typeof finalBid === 'number') {
        toast.success(
          `🎉 You won — card paid ${fmtUsd(finalBid)} and added to collection`,
        );
      } else if (ev === 'auction_sold' && typeof netCents === 'number') {
        toast.success(`Sold at auction for ${fmtUsd(netCents)} (after fee)`);
      } else if (ev === 'card_bought' && typeof priceCents === 'number') {
        if (pathname?.startsWith('/market/')) return;
        toast.success(`Card acquired for ${fmtUsd(priceCents)}`);
      } else if (ev === 'card_sold' && typeof netCents === 'number') {
        toast.success(`Card sold for ${fmtUsd(netCents)} (after fee)`);
      }
    },
  });

  return null;
}
