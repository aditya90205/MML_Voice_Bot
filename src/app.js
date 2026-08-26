import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.corsOrigins === '*' ? true : env.corsOrigins,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: env.isDev,
      quietReqLogger: true,
    })
  );

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      max: env.isProd ? 120 : 1000,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      },
    })
  );

  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        name: 'MML Voice Backend',
        docs: 'See README.md for Socket.IO + REST contract',
        health: '/api/health',
      },
    });
  });

  app.use('/api', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
