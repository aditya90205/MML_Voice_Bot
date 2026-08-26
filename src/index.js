import http from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { bindCallService } from './services/callService.js';
import { registerSocketHandlers } from './sockets/index.js';

const app = createApp();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: env.corsOrigins === '*' ? true : env.corsOrigins,
    methods: ['GET', 'POST'],
  },
  pingInterval: env.SOCKET_PING_INTERVAL_MS,
  pingTimeout: env.SOCKET_PING_TIMEOUT_MS,
  maxHttpBufferSize: 5e6, // allow audio frames
});

bindCallService(io);
registerSocketHandlers(io);

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      nodeEnv: env.NODE_ENV,
    },
    'MML Voice Backend listening'
  );
});

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  try {
    io.close();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Shutdown error');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
