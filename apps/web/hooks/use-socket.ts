'use client';

import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';

type EventEnvelope = { channel: string } & Record<string, unknown>;

interface UseChannelOptions {
  onEvent: (payload: EventEnvelope) => void;
  /**
   * Called after a reconnect. Per ARCHITECTURE §7.3, the WS layer is
   * delta-only — the page must refetch authoritative state from REST
   * on reconnect rather than gap-filling from a server buffer.
   */
  onReconnect?: () => void;
}

let sharedSocket: Socket | null = null;
let socketPromise: Promise<Socket | null> | null = null;
let warnedNoUrl = false;

async function fetchWsToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/ws-token', { credentials: 'include' });
    if (!res.ok) {
      console.warn('[ws] /api/auth/ws-token returned', res.status);
      return null;
    }
    const j = (await res.json()) as { token?: unknown };
    return typeof j.token === 'string' ? j.token : null;
  } catch (err) {
    console.warn('[ws] /api/auth/ws-token fetch failed:', err);
    return null;
  }
}

async function getSocket(): Promise<Socket | null> {
  if (sharedSocket) return sharedSocket;
  if (socketPromise) return socketPromise;

  socketPromise = (async (): Promise<Socket | null> => {
    const url = process.env.NEXT_PUBLIC_WS_URL;
    if (!url) {
      if (!warnedNoUrl && typeof window !== 'undefined') {
        console.warn('[ws] NEXT_PUBLIC_WS_URL not set — live updates disabled');
        warnedNoUrl = true;
      }
      return null;
    }

    // Cross-domain WS auth: cookies don't cross unrelated origins (Vercel
    // domain ≠ Railway domain) even with SameSite=None. Fetch the JWT from
    // a same-origin endpoint and pass it via the Socket.IO handshake.
    const token = await fetchWsToken();
    if (!token) {
      console.warn('[ws] no auth token — live updates disabled');
      return null;
    }

    if (typeof window !== 'undefined') {
      console.log('[ws] connecting to:', url);
    }

    const socket = io(url, {
      auth: { token },
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });
    sharedSocket = socket;
    return socket;
  })();

  return socketPromise;
}

export function useChannel(channel: string, options: UseChannelOptions): void {
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const socket = await getSocket();
      if (cancelled || !socket) return;
      const manager = socket.io;

      const handleEvent = (payload: EventEnvelope): void => {
        if (payload?.channel === channel) optsRef.current.onEvent(payload);
      };
      const subscribe = (): void => {
        socket.emit('subscribe', channel);
      };
      const handleReconnect = (): void => {
        subscribe();
        optsRef.current.onReconnect?.();
      };

      socket.on('event', handleEvent);
      socket.on('connect', subscribe);
      manager.on('reconnect', handleReconnect);

      if (socket.connected) subscribe();

      cleanup = (): void => {
        socket.off('event', handleEvent);
        socket.off('connect', subscribe);
        manager.off('reconnect', handleReconnect);
        socket.emit('unsubscribe', channel);
      };
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, [channel]);
}
