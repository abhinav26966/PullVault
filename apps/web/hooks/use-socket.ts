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

function getSocket(): Socket {
  if (sharedSocket) return sharedSocket;
  const url = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000';
  sharedSocket = io(url, {
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  return sharedSocket;
}

export function useChannel(channel: string, options: UseChannelOptions): void {
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    const socket = getSocket();
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

    return () => {
      socket.off('event', handleEvent);
      socket.off('connect', subscribe);
      manager.off('reconnect', handleReconnect);
      socket.emit('unsubscribe', channel);
    };
  }, [channel]);
}
