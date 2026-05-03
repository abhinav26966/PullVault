import type { Server as IoServer } from 'socket.io';
import { subscriber } from './redis';

const PATTERNS = ['drop:*', 'auction:*', 'listing:*', 'user:*', 'prices:*'];

export async function startPubSub(io: IoServer): Promise<void> {
  await subscriber.psubscribe(...PATTERNS);
  subscriber.on('pmessage', (_pattern, channel, message) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch (err) {
      console.error(`[pubsub] bad JSON on ${channel}`, err);
      return;
    }
    io.to(channel).emit('event', { channel, ...payload });
  });
  console.log('[pubsub] psubscribed to', PATTERNS.join(', '));
}
