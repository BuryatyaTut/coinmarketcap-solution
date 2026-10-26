export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

export const invalid = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
export const notFound = () => new AppError(404, 'NOT_FOUND', 'Cryptocurrency not found');
export const unavailable = () => new AppError(503, 'STOPPING', 'Service is stopping');

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'INTERNAL_ERROR';
}
