import axios, { AxiosInstance } from 'axios';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, unavailable } from './errors';
import { Clock, PriceProvider, Quote, QuoteResult } from './types';
import { object, timestamp, trimmedText } from './validation';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK = 7 * DAY;
const malformed = () => new AppError(502, 'UPSTREAM_INVALID', 'Provider returned invalid price data');

export function parseQuotes(payload: unknown, ids: number[], now: number): QuoteResult {
  let body: Record<string, unknown>;
  let status: Record<string, unknown>;
  try {
    body = object(payload);
    status = object(body.status);
  } catch {
    throw malformed();
  }

  // v3 may serialize success as "0"; absent/null error fields are also harmless.
  const hasErrorCode = status.error_code != null && status.error_code !== 0 && status.error_code !== '0';
  const hasErrorMessage = status.error_message != null && status.error_message !== '';
  if (hasErrorCode || hasErrorMessage || !Array.isArray(body.data)) throw malformed();

  const quotes: Quote[] = [];
  const invalidIds: number[] = [];
  const seen = new Set<number>();
  for (const entry of body.data) {
    const raw = object(entry);
    const id = raw.id;
    if (typeof id !== 'number' || !ids.includes(id) || seen.has(id)) throw malformed();
    seen.add(id);

    try {
      const name = trimmedText(raw.name, 'name', 120);
      const symbol = trimmedText(raw.symbol, 'symbol', 64);
      if (!Array.isArray(raw.quote)) throw malformed();
      const usdQuotes = raw.quote.filter(quote => quote && typeof quote === 'object' && quote.symbol === 'USD');
      if (usdQuotes.length !== 1) throw malformed();
      const quote = object(usdQuotes[0]);
      if (typeof quote.price !== 'number' || !Number.isFinite(quote.price) || quote.price < 0) throw malformed();
      const sourceUpdatedAt = timestamp(quote.last_updated);
      if (Date.parse(sourceUpdatedAt) > now + MINUTE) throw malformed();

      quotes.push({
        cmcId: id,
        symbol,
        name,
        price: quote.price,
        observedAt: new Date(now).toISOString(),
        sourceUpdatedAt,
      });
    } catch {
      invalidIds.push(id);
    }
  }
  return { quotes, missingIds: ids.filter(id => !seen.has(id)), invalidIds };
}

function rateLimitWait(quotaCode: unknown, retryAfter: unknown, now: number): number {
  let fallback = MINUTE;
  if (quotaCode === 1009 || quotaCode === '1009') fallback = DAY;
  if (quotaCode === 1010 || quotaCode === '1010') fallback = WEEK;
  if (typeof retryAfter !== 'string') return fallback;

  const headerWait = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter) - now;
  return Math.min(WEEK, Math.max(fallback, headerWait || 0));
}

export class CoinMarketCapClient implements PriceProvider {
  private readonly http: Pick<AxiosInstance, 'get'>;
  private cooldownUntil = 0;

  constructor(
    private readonly key: string,
    private readonly timeoutMs: number,
    private readonly clock: Clock = Date.now,
    http?: Pick<AxiosInstance, 'get'>,
    private readonly retryDelayMs = 250,
  ) {
    this.http = http ?? axios.create({
      baseURL: 'https://pro-api.coinmarketcap.com',
      maxRedirects: 0,
      maxContentLength: 2 * 1024 * 1024,
    });
  }

  async latest(ids: number[], signal?: AbortSignal): Promise<QuoteResult> {
    if (!ids.length) return { quotes: [], missingIds: [], invalidIds: [] };
    if (signal?.aborted) throw unavailable();
    if (this.clock() < this.cooldownUntil) {
      throw new AppError(503, 'UPSTREAM_RATE_LIMIT', 'Provider temporarily unavailable', this.cooldownUntil - this.clock());
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const deadline = AbortSignal.timeout(this.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      try {
        const response = await this.http.get('/v3/cryptocurrency/quotes/latest', {
          params: { id: ids.join(','), convert: 'USD', skip_invalid: true },
          headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': this.key },
          timeout: this.timeoutMs,
          signal: requestSignal,
        });
        try {
          return parseQuotes(response.data, ids, this.clock());
        } catch {
          throw malformed();
        }
      } catch (error) {
        if (signal?.aborted) throw unavailable();
        if (error instanceof AppError) throw error;
        const response = axios.isAxiosError(error) ? error.response : undefined;
        const status = response?.status;
        const providerStatus = response?.data?.status;
        // v3 reports an absent single ID as 400; unrelated request failures stay upstream errors.
        if (status === 400 && ids.length === 1
          && (providerStatus?.error_code === 400 || providerStatus?.error_code === '400')
          && providerStatus?.error_message === `No data found for 'id': '${ids[0]}'`) {
          return { quotes: [], missingIds: [ids[0]], invalidIds: [] };
        }
        if (status === 401 || status === 402 || status === 403) {
          throw new AppError(503, 'UPSTREAM_ACCESS', 'Provider access is unavailable');
        }
        if (status === 429) {
          const wait = rateLimitWait(response?.data?.status?.error_code, response?.headers?.['retry-after'], this.clock());
          this.cooldownUntil = this.clock() + wait;
          throw new AppError(503, 'UPSTREAM_RATE_LIMIT', 'Provider rate limit reached', wait);
        }

        const timeout = deadline.aborted || (axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? ''));
        const transient = status === undefined || status >= 500;
        if (transient && attempt === 0) {
          try {
            await delay(this.retryDelayMs, undefined, { signal });
          } catch {
            throw unavailable();
          }
          continue;
        }
        if (timeout) throw new AppError(504, 'UPSTREAM_TIMEOUT', 'Provider request timed out');
        throw new AppError(502, 'UPSTREAM_ERROR', 'Unable to obtain provider prices');
      }
    }
    throw malformed();
  }
}
