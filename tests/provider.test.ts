import axios, { AxiosError, AxiosInstance } from 'axios';
import { createServer } from 'node:http';
import request from 'supertest';
import { createApp } from '../src/app';
import { CoinMarketCapClient, parseQuotes } from '../src/coinmarketcap';
import { TrackerService } from '../src/service';
import { fixture, NOW, TOKEN } from './helpers';

const sample = (id = 1) => ({ id, symbol: 'BTC', name: 'Bitcoin', quote: [
  { symbol: 'EUR', price: 10, last_updated: '2026-10-23T10:00:00Z' },
  { symbol: 'USD', price: 12.345, last_updated: '2026-10-23T09:59:59Z' },
] });
const payload = (data: unknown[] = [sample()]) => ({ data, status: { error_code: 0 } });
function setup() {
  const get = jest.fn();
  const client = new CoinMarketCapClient('test-provider-key', 1000, () => NOW,
    { get } as unknown as Pick<AxiosInstance, 'get'>, 1);
  return { get, client };
}
function httpError(status: number, code?: number | string, retryAfter?: string, errorMessage?: unknown) {
  return new AxiosError('secret-provider-detail', undefined, undefined, undefined,
    { status, data: { status: { error_code: code, error_message: errorMessage } },
      headers: { 'retry-after': retryAfter }, statusText: '', config: {} } as never);
}

test('uses v3 IDs, USD, header auth, timeout and cancellation; selects USD by symbol', async () => {
  const { get, client } = setup();
  get.mockResolvedValue({ data: payload() });
  const result = await client.latest([1]);
  expect(result.quotes[0].price).toBe(12.345);
  expect(result.quotes[0].sourceUpdatedAt).toBe('2026-10-23T09:59:59.000Z');
  expect(get).toHaveBeenCalledWith('/v3/cryptocurrency/quotes/latest', expect.objectContaining({
    params: { id: '1', convert: 'USD', skip_invalid: true }, timeout: 1000,
    headers: { Accept: 'application/json', 'X-CMC_PRO_API_KEY': 'test-provider-key' }, signal: expect.any(AbortSignal),
  }));
});

test('handles empty watchlist without HTTP', async () => {
  const { get, client } = setup();
  expect((await client.latest([])).quotes).toEqual([]);
  expect(get).not.toHaveBeenCalled();
});

test.each([
  { timestamp: '2026-10-23T10:00:00Z', credit_count: 1 },
  { error_code: null, error_message: null, credit_count: 1 },
  { error_code: '0', error_message: '', credit_count: 1 },
])('accepts v3 success with absent/null or string error code: %j', async status => {
  const { get, client } = setup();
  get.mockResolvedValue({ data: { data: [sample()], status } });
  expect((await client.latest([1])).quotes[0].price).toBe(12.345);
  expect(get).toHaveBeenCalledTimes(1);
});

test.each([[], { error_code: '1001' }, { error_code: '' }, { error_code: false }, { error_message: 'Provider error' },
  { error_code: 0, error_message: 'Provider error' }])(
  'rejects malformed status or explicit errors even with valid quotes: %j', async status => {
    const { get, client } = setup();
    get.mockResolvedValue({ data: { data: [sample()], status } });
    await expect(client.latest([1])).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_INVALID' });
    expect(get).toHaveBeenCalledTimes(1);
  });

test.each([null, {}, { data: {}, status: { error_code: 0 } }, { data: [], status: { error_code: 12 } }])(
  'rejects malformed success envelope %j', async data => {
    const { get, client } = setup();
    get.mockResolvedValue({ data });
    await expect(client.latest([1])).rejects.toMatchObject({ status: 502, code: 'UPSTREAM_INVALID' });
    expect(get).toHaveBeenCalledTimes(1);
  });

test('separates missing and invalid assets while keeping valid observations', () => {
  const bad = { ...sample(2), quote: [{ symbol: 'USD', price: -1, last_updated: '2026-10-23T10:00:00Z' }] };
  const result = parseQuotes(payload([sample(), bad]), [1, 2, 3], NOW);
  expect(result.quotes).toHaveLength(1);
  expect(result.invalidIds).toEqual([2]);
  expect(result.missingIds).toEqual([3]);
});

test.each(['name', 'symbol'])('skips a quote with a NUL in %s while preserving valid quotes', field => {
  const invalid = { ...sample(2), [field]: 'bad\u0000value' };
  const result = parseQuotes(payload([sample(), invalid]), [1, 2], NOW);
  expect(result.quotes.map(quote => quote.cmcId)).toEqual([1]);
  expect(result.invalidIds).toEqual([2]);
  expect(result.missingIds).toEqual([]);
});

test.each([NaN, Infinity, -1, '12', null])('rejects invalid price %s', price => {
  const item = sample();
  (item.quote[1] as { price: unknown }).price = price;
  expect(parseQuotes(payload([item]), [1], NOW).invalidIds).toEqual([1]);
});

test('rejects absent USD, duplicate IDs, wrong IDs and impossible/future timestamps', () => {
  expect(parseQuotes(payload([{ ...sample(), quote: [] }]), [1], NOW).invalidIds).toEqual([1]);
  expect(() => parseQuotes(payload([sample(), sample()]), [1], NOW)).toThrow();
  expect(() => parseQuotes(payload([sample(99)]), [1], NOW)).toThrow();
  for (const date of ['2026-02-30T00:00:00Z', '2026-10-24T00:00:00Z']) {
    const item = sample();
    item.quote[1].last_updated = date;
    expect(parseQuotes(payload([item]), [1], NOW).invalidIds).toEqual([1]);
  }
});

test.each([401, 402, 403])('provider access status %i is not retried or leaked', async status => {
  const { get, client } = setup();
  get.mockRejectedValue(httpError(status));
  await expect(client.latest([1])).rejects.toMatchObject({ status: 503, code: 'UPSTREAM_ACCESS' });
  expect(get).toHaveBeenCalledTimes(1);
});

test.each([1008, 1009, 1010, '1008', '1009', '1010'])('rate limit %s installs cooldown and does not retry immediately', async code => {
  const { get, client } = setup();
  get.mockRejectedValue(httpError(429, code));
  const retryAfterMs = Number(code) === 1009 ? 86400000 : Number(code) === 1010 ? 604800000 : 60000;
  await expect(client.latest([1])).rejects.toMatchObject({ status: 503, code: 'UPSTREAM_RATE_LIMIT', retryAfterMs });
  await expect(client.latest([1])).rejects.toMatchObject({ status: 503 });
  expect(get).toHaveBeenCalledTimes(1);
});

test.each<[string, number]>([
  ['120', 120_000],
  [new Date(NOW + 180_000).toUTCString(), 180_000],
  ['invalid-date', 60_000],
  ['0', 60_000],
  ['1', 60_000],
  ['999999999', 604_800_000],
])('respects Retry-After %s within the cooldown bounds', async (header, retryAfterMs) => {
  const { get, client } = setup();
  get.mockRejectedValue(httpError(429, 1008, header));
  await expect(client.latest([1])).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT', retryAfterMs });
  await expect(client.latest([1])).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMIT', retryAfterMs });
  expect(get).toHaveBeenCalledTimes(1);
});

test('transient failure retries once then succeeds', async () => {
  const { get, client } = setup();
  get.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce({ data: payload() });
  expect((await client.latest([1])).quotes).toHaveLength(1);
  expect(get).toHaveBeenCalledTimes(2);
});

test('network failure and timeout retry at most once with sanitized errors', async () => {
  for (const code of ['ECONNRESET', 'ECONNABORTED']) {
    const { get, client } = setup();
    get.mockRejectedValue(new AxiosError('private-key', code));
    await expect(client.latest([1])).rejects.toMatchObject({ status: code === 'ECONNABORTED' ? 504 : 502 });
    expect(get).toHaveBeenCalledTimes(2);
  }
});

test('provider 400 is not incorrectly treated as unknown asset', async () => {
  const { get, client } = setup();
  get.mockRejectedValue(httpError(400));
  await expect(client.latest([1])).rejects.toMatchObject({ status: 502 });
  expect(get).toHaveBeenCalledTimes(1);
});

test.each([400, '400'])('confirmed missing ID with provider code %s returns absence without retry', async code => {
  const { get, client } = setup();
  get.mockRejectedValueOnce(httpError(400, code, undefined, "No data found for 'id': '9999999'"))
    .mockResolvedValueOnce({ data: payload() });
  await expect(client.latest([9999999])).resolves.toEqual({ quotes: [], missingIds: [9999999], invalidIds: [] });
  expect(get).toHaveBeenCalledTimes(1);
  expect((await client.latest([1])).quotes).toHaveLength(1);
  expect(get).toHaveBeenCalledTimes(2);
});

test.each([
  { ids: [9999999], httpStatus: 400, code: 400, message: "Invalid value for 'convert': 'USD'", expected: 502, attempts: 1 },
  { ids: [9999999], httpStatus: 400, code: 400, message: "No data found for 'id': '9999998'", expected: 502, attempts: 1 },
  { ids: [9999999], httpStatus: 400, code: 400, message: { detail: 'private detail' }, expected: 502, attempts: 1 },
  { ids: [9999999], httpStatus: 400, code: 1001, message: "No data found for 'id': '9999999'", expected: 502, attempts: 1 },
  { ids: [1, 9999999], httpStatus: 400, code: 400, message: "No data found for 'id': '9999999'", expected: 502, attempts: 1 },
  { ids: [9999999], httpStatus: 500, code: 400, message: "No data found for 'id': '9999999'", expected: 502, attempts: 2 },
  { ids: [9999999], httpStatus: 401, code: 400, message: "No data found for 'id': '9999999'", expected: 503, attempts: 1 },
])('unrelated provider error stays upstream: %j', async ({ ids, httpStatus, code, message, expected, attempts }) => {
  const { get, client } = setup();
  get.mockRejectedValue(httpError(httpStatus, code, undefined, message));
  await expect(client.latest(ids)).rejects.toMatchObject({ status: expected,
    code: expected === 503 ? 'UPSTREAM_ACCESS' : 'UPSTREAM_ERROR' });
  expect(get).toHaveBeenCalledTimes(attempts);
});

test('real provider HTTP 400 becomes API 422 without rows or leaked details; later requests still work', async () => {
  const f = fixture();
  let providerCalls = 0;
  const upstream = createServer((req, res) => {
    providerCalls++;
    const id = new URL(req.url!, 'http://localhost').searchParams.get('id');
    res.setHeader('Content-Type', 'application/json');
    if (id === '9999999') {
      res.writeHead(400).end(JSON.stringify({ status: {
        error_code: '400', error_message: "No data found for 'id': '9999999'", credit_count: 0,
      } }));
    } else res.end(JSON.stringify(payload()));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as { port: number }).port;
  const client = new CoinMarketCapClient('test-provider-key', 1000, () => NOW,
    axios.create({ baseURL: `http://127.0.0.1:${port}`, proxy: false }));
  const app = createApp(new TrackerService(f.repo, client, 900000, () => NOW, f.log), TOKEN, f.log);
  const base = '/api/v1/cryptocurrencies';
  try {
    await request(app).post(base).send({ cmcId: 9999999 }).expect(401);
    expect(providerCalls).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(app).post(base).set('Authorization', `Bearer ${TOKEN}`)
        .send({ cmcId: 9999999 }).expect(422);
      expect(result.body).toEqual({ error: { code: 'UNKNOWN_ASSET',
        message: 'CoinMarketCap asset ID not found', requestId: result.headers['x-request-id'] } });
      expect(f.repo.list({ limit: 100, offset: 0 })).toEqual([]);
      expect(f.repo.db.prepare('SELECT count(*) AS n FROM price_history').get()?.n).toBe(0);
    }
    expect(providerCalls).toBe(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/No data found|test-provider-key/);
    await request(app).post(base).set('Authorization', `Bearer ${TOKEN}`).send({ cmcId: 1 }).expect(201);
    expect(providerCalls).toBe(3);
    expect(f.repo.latest(1)?.price).toBe(12.345);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    f.cleanup();
  }
});

test('cancellation interrupts a retry delay', async () => {
  const get = jest.fn().mockRejectedValue(httpError(500));
  const client = new CoinMarketCapClient('test', 1000, () => NOW, { get } as never, 60000);
  const controller = new AbortController();
  const pending = client.latest([1], controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'STOPPING' });
  expect(get).toHaveBeenCalledTimes(1);
});

test('real axios adapter cancels a hanging local HTTP request', async () => {
  let notify: () => void;
  const received = new Promise<void>(resolve => { notify = resolve; });
  const server = createServer((_req, _res) => notify());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = new CoinMarketCapClient('test', 1000, Date.now, axios.create({ baseURL: `http://127.0.0.1:${port}` }));
  const controller = new AbortController();
  try {
    const pending = client.latest([1], controller.signal);
    await received;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'STOPPING' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
