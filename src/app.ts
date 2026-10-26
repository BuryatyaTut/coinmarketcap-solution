import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError, errorCode, invalid, unavailable } from './errors';
import { TrackerService } from './service';
import { Logger } from './types';
import { createBody, integer, keys, pageResult, pagination, updateBody } from './validation';

function toHttpError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  const details = error as { type?: string; status?: number; code?: string; errcode?: number } | null;
  // SQLite extended codes retain BUSY (5) or LOCKED (6) in their low byte.
  if (details?.code === 'ERR_SQLITE_ERROR' && typeof details.errcode === 'number'
    && [5, 6].includes(details.errcode & 0xff)) {
    return new AppError(503, 'DATABASE_BUSY', 'Database is busy; retry shortly', 1000);
  }
  if (error instanceof URIError && details?.status === 400) {
    return invalid('Malformed URL parameter');
  }
  if (details?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 16 KB');
  }
  if (details?.type === 'charset.unsupported' || details?.type === 'encoding.unsupported') {
    return new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported body encoding');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
}

export function createApp(service: TrackerService, apiToken: string, log: Logger, shutdownSignal?: AbortSignal) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  const expected = createHash('sha256').update(apiToken).digest();
  const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('Cache-Control', 'no-store');
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
    if (!match || !timingSafeEqual(expected, createHash('sha256').update(match[1]).digest())) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(new AppError(401, 'UNAUTHORIZED', 'A valid application Bearer token is required'));
      return;
    }
    if (shutdownSignal?.aborted) {
      next(unavailable());
      return;
    }
    next();
  });

  const json = express.json({ limit: '16kb', strict: true });
  const body: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) {
      next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json'));
      return;
    }
    json(req, res, (error?: unknown) => {
      // Only parser errors are handled here; application errors cannot claim a client status.
      if ((error as { status?: number } | null)?.status === 400) {
        next(invalid('Malformed JSON body'));
        return;
      }
      next(error);
    });
  };

  const base = '/api/v1/cryptocurrencies';
  app.post(base, body, async (req, res) => {
    keys(req.query, []);
    const id = createBody(req.body);
    const client = new AbortController();
    const abort = () => client.abort();
    res.on('close', abort);
    try {
      const signal = shutdownSignal ? AbortSignal.any([shutdownSignal, client.signal]) : client.signal;
      const result = await service.create(id, signal);
      res.status(201).location(`${base}/${result.id}`).json(result);
    } finally {
      res.off('close', abort);
    }
  });

  app.get(base, (req, res) => {
    const page = pagination(req.query);
    res.json(pageResult(service.repo.list(page), page));
  });

  app.get(`${base}/:id`, (req, res) => {
    keys(req.query, []);
    res.json(service.repo.get(integer(req.params.id, 'id')));
  });

  app.patch(`${base}/:id`, body, (req, res) => {
    keys(req.query, []);
    res.json(service.rename(integer(req.params.id, 'id'), updateBody(req.body)));
  });

  app.delete(`${base}/:id`, (req, res) => {
    keys(req.query, []);
    service.repo.delete(integer(req.params.id, 'id'));
    res.status(204).end();
  });

  app.get(`${base}/:id/price`, (req, res) => {
    keys(req.query, []);
    res.json(service.latest(integer(req.params.id, 'id')));
  });

  app.get(`${base}/:id/history`, (req, res) => {
    const filter = pagination(req.query, true);
    res.json(pageResult(service.repo.history(integer(req.params.id, 'id'), filter), filter));
  });

  app.get('/api/v1/prices', (req, res) => {
    const page = pagination(req.query);
    const items = service.repo.list(page).map(coin => ({
      cryptocurrency: coin,
      latestPrice: service.withFreshness(service.repo.latest(coin.id)),
    }));
    res.json(pageResult(items, page));
  });

  app.get('/openapi.json', (req, res) => {
    keys(req.query, []);
    res.json(spec);
  });

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const mapped = toHttpError(error);
    log('request_failed', { requestId: res.locals.requestId, code: errorCode(mapped), status: mapped.status });
    if (!res.headersSent && !res.destroyed) {
      if (mapped.retryAfterMs) res.setHeader('Retry-After', Math.ceil(mapped.retryAfterMs / 1000));
      res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message, requestId: res.locals.requestId } });
    }
  };
  app.use(handleError);
  return app;
}
