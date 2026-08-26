import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

export function requireApiKey(req, _res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== env.API_KEY) {
    return next(
      new AppError('Invalid or missing API key', {
        statusCode: 401,
        code: 'UNAUTHORIZED',
      })
    );
  }
  return next();
}
