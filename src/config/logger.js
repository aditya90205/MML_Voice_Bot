import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'mml-voice-backend',
    env: env.NODE_ENV,
  },
  transport: env.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

export default logger;
