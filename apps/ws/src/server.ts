import './env';
import { createServer } from 'node:http';
import { Server as IoServer } from 'socket.io';
import { authenticate } from './auth';
import { registerDisconnectHandler } from './handlers/disconnect';
import { registerSubscribeHandler } from './handlers/subscribe';
import { runDropActivatorNow, scheduleDropActivator } from './jobs/drop-activator';
import { startPubSub } from './pubsub';

const PORT = Number(process.env.PORT ?? 4000);
const WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

async function main(): Promise<void> {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pullvault-ws ok\n');
  });

  const io = new IoServer(httpServer, {
    cors: {
      origin: WEB_PUBLIC_URL,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const session = authenticate(socket);
    if (!session) {
      next(new Error('UNAUTHORIZED'));
      return;
    }
    socket.data.userId = session.userId;
    next();
  });

  io.on('connection', (socket) => {
    registerSubscribeHandler(io, socket);
    registerDisconnectHandler(io, socket);
  });

  await startPubSub(io);

  await runDropActivatorNow();
  scheduleDropActivator();
  console.log('[ws] drop-activator scheduled (every 60s)');

  httpServer.listen(PORT, () => {
    console.log(`[ws] listening on :${PORT}, CORS origin ${WEB_PUBLIC_URL}`);
  });

  const shutdown = (sig: string): void => {
    console.log(`[ws] ${sig} received, shutting down`);
    httpServer.close();
    io.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[ws] fatal', err);
  process.exit(1);
});
