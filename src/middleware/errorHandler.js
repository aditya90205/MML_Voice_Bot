import { AppError } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export function notFoundHandler(req, _res, next) {
  next(
    new AppError(`Route not found: ${req.method} ${req.originalUrl}`, {
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
    })
  );
}

export function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message =
    statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  if (statusCode >= 500) {
    logger.error({ err }, 'Unhandled error');
  } else {
    logger.warn({ err: { message: err.message, code, details: err.details } }, 'Request failed');
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      details: err.details,
    },
  });
}
