import 'server-only';
import Redis from 'ioredis';

declare global {
  // eslint-disable-next-line no-var
  var __pullvault_redis_publisher: Redis | undefined;
}

function getPublisher(): Redis {
  if (!globalThis.__pullvault_redis_publisher) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required');
    const client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    client.on('error', (err) => console.error('[redis publisher]', err));
    globalThis.__pullvault_redis_publisher = client;
  }
  return globalThis.__pullvault_redis_publisher;
}

/**
 * Publish a payload to a Redis Pub/Sub channel.
 *
 * Call ONLY after the surrounding db.transaction() has committed. Per
 * ARCHITECTURE §6.1 step 8, publishing before commit can broadcast a
 * phantom event if the transaction rolls back.
 */
export async function publish(channel: string, payload: unknown): Promise<void> {
  await getPublisher().publish(channel, JSON.stringify(payload));
}
