'use client';

import { usePathname, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useChannel } from '@/hooks/use-socket';

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

const WALLET_TOAST_DURATION_MS = 5000;

/**
 * Global subscriber to `user:{userId}` events. Fires toasts for events the
 * user should know about regardless of which page they're on, and forces a
 * router.refresh() on every wallet-changing event so the (app) layout
 * re-runs its wallet query and the header balance reflects the change. The
 * layout is shared across (app) routes and Next.js's router cache treats
 * the layout segment as stable across sibling navigations — without an
 * explicit invalidation here, the seller's header would stay frozen at the
 * pre-trade balance until they hard-reload.
 *
 * console.debug breadcrumb is intentional: if a toast ever fails to render,
 * the breadcrumb tells you whether the event arrived (toast rendering bug)
 * or never reached this client (subscription / WS bug).
 */
export default function UserToastSubscriber({ userId }: { userId: string }) {
  const pathname = usePathname();
  const router = useRouter();

  useChannel(`user:${userId}`, {
    onEvent: (payload) => {
      const ev = (payload as { event?: string }).event;
      const auctionId = (payload as { auctionId?: unknown }).auctionId;
      const finalBid = (payload as { finalBid?: unknown }).finalBid;
      const netCents = (payload as { netCents?: unknown }).netCents;
      const priceCents = (payload as { priceCents?: unknown }).priceCents;
      const packId = (payload as { packId?: unknown }).packId;

      console.debug('[user-toast] received event', ev, payload);

      if (ev === 'pack_minted' && typeof packId === 'string') {
        // Lottery winner. If the user is on the drop page, DropBuyClient
        // handles the toast + redirect via its own user-channel subscription;
        // we skip here to avoid a double navigation. The toast `id` would
        // dedupe react-hot-toast either way, but skipping the router.push
        // avoids a pointless second navigation.
        router.refresh();
        if (pathname?.startsWith('/drops/')) return;
        toast.success('🎉 Pack acquired — opening…', {
          id: `pack-minted-${packId}`,
          duration: WALLET_TOAST_DURATION_MS,
        });
        router.push(`/packs/${packId}`);
        return;
      }
      if (ev === 'lottery_lost') {
        // Same logic — DropBuyClient handles its own page; we cover any
        // other page the user might have navigated to.
        if (pathname?.startsWith('/drops/')) return;
        toast("Didn't win this lottery — try the next drop", {
          id: `lottery-lost-${(payload as { dropId?: unknown }).dropId ?? 'unknown'}`,
          icon: '🎰',
          duration: WALLET_TOAST_DURATION_MS,
        });
        return;
      }

      if (ev === 'outbid' && typeof auctionId === 'string') {
        // Refund moved held → available; layout needs to re-fetch.
        router.refresh();
        if (pathname === `/auctions/${auctionId}`) return;
        toast('⚠ You’ve been outbid — return to the auction to bid again', {
          icon: '⚠️',
          duration: WALLET_TOAST_DURATION_MS,
        });
      } else if (ev === 'auction_won' && typeof finalBid === 'number') {
        router.refresh();
        toast.success(
          `🎉 You won — card paid ${fmtUsd(finalBid)} and added to collection`,
          { duration: WALLET_TOAST_DURATION_MS },
        );
      } else if (ev === 'auction_sold' && typeof netCents === 'number') {
        router.refresh();
        toast.success(`Sold at auction for ${fmtUsd(netCents)} (after fee)`, {
          duration: WALLET_TOAST_DURATION_MS,
        });
      } else if (ev === 'card_bought' && typeof priceCents === 'number') {
        router.refresh();
        if (pathname?.startsWith('/market/')) return;
        toast.success(`Card acquired for ${fmtUsd(priceCents)}`, {
          duration: WALLET_TOAST_DURATION_MS,
        });
      } else if (ev === 'card_sold' && typeof netCents === 'number') {
        router.refresh();
        toast.success(`Card sold for ${fmtUsd(netCents)} (after fee)`, {
          duration: WALLET_TOAST_DURATION_MS,
        });
      }
    },
  });

  return null;
}
