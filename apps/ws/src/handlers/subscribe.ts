import type { Server as IoServer, Socket } from 'socket.io';

const CHANNEL_PATTERN = /^(drop|auction|listing|prices|user):[A-Za-z0-9_:.-]+$/;

type Ack = (res: { ok: boolean; error?: string }) => void;

function emitWatcherCount(io: IoServer, channel: string, sizeOverride?: number): void {
  const size = sizeOverride ?? io.sockets.adapter.rooms.get(channel)?.size ?? 0;
  io.to(channel).emit('event', { channel, event: 'watchers', count: size });
}

export function registerSubscribeHandler(io: IoServer, socket: Socket): void {
  socket.on('subscribe', (channel: unknown, ack?: Ack) => {
    if (typeof channel !== 'string' || !CHANNEL_PATTERN.test(channel)) {
      ack?.({ ok: false, error: 'invalid channel' });
      return;
    }
    if (channel.startsWith('user:') && channel !== `user:${socket.data.userId}`) {
      ack?.({ ok: false, error: 'forbidden' });
      return;
    }
    socket.join(channel);
    ack?.({ ok: true });
    if (channel.startsWith('auction:')) emitWatcherCount(io, channel);
  });

  socket.on('unsubscribe', (channel: unknown, ack?: Ack) => {
    if (typeof channel !== 'string') {
      ack?.({ ok: false });
      return;
    }
    socket.leave(channel);
    ack?.({ ok: true });
    if (channel.startsWith('auction:')) emitWatcherCount(io, channel);
  });
}
