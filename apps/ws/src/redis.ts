import './env';
import Redis from 'ioredis';

function buildClient(role: string): Redis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
  });
  client.on('error', (err) => console.error(`[redis ${role}]`, err));
  return client;
}

export const subscriber = buildClient('subscriber');
export const publisher = buildClient('publisher');
