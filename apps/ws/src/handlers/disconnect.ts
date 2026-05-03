import type { Server as IoServer, Socket } from 'socket.io';

export function registerDisconnectHandler(io: IoServer, socket: Socket): void {
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (!room.startsWith('auction:')) continue;
      // socket.rooms still includes this socket; the post-leave count is size - 1.
      const current = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      const after = Math.max(0, current - 1);
      io.to(room).emit('event', { channel: room, event: 'watchers', count: after });
    }
  });
}
