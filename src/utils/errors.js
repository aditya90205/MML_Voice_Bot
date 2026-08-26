export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function assertFound(value, message = 'Resource not found') {
  if (!value) {
    throw new AppError(message, { statusCode: 404, code: 'NOT_FOUND' });
  }
  return value;
}
