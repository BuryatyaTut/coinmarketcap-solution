import request from 'supertest';
import { AppError } from '../src/errors';
import { fixture, quote, TOKEN } from './helpers';

const base = '/api/v1/cryptocurrencies';
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());
const auth = { Authorization: `Bearer ${TOKEN}` };

test('complete CRUD workflow persists initial quote, preserves history on rename and cascades deletion', async () => {
  const created = await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(201);
  const id = created.body.id;
  expect(created.headers.location).toBe(`${base}/${id}`);
  expect(f.repo.latest(id)?.price).toBe(12.345);
  const listing = await request(f.app).get(base).set(auth).expect(200);
  expect(listing.body.items).toHaveLength(1);
  await request(f.app).get(`${base}/${id}`).set(auth).expect(200);
  f.advance(1000);
  const changed = await request(f.app).patch(`${base}/${id}`).set(auth).send({ name: ' My Bitcoin ' }).expect(200);
  expect(changed.body.name).toBe('My Bitcoin');
  expect(changed.body.lastPriceAt).toBe(created.body.lastPriceAt);
  const price = await request(f.app).get(`${base}/${id}/price`).set(auth).expect(200);
  expect(price.body.stale).toBe(false);
  const history = await request(f.app).get(`${base}/${id}/history`).set(auth).expect(200);
  expect(history.body.items).toHaveLength(1);
  const prices = await request(f.app).get('/api/v1/prices').set(auth).expect(200);
  expect(prices.body.items[0].latestPrice.price).toBe(12.345);
  await request(f.app).delete(`${base}/${id}`).set(auth).expect(204);
  expect(f.repo.latest(id)).toBeNull();
  await request(f.app).get(`${base}/${id}`).set(auth).expect(404);
});

test.each([
  ['post', base], ['get', base], ['get', `${base}/1`], ['patch', `${base}/1`], ['delete', `${base}/1`],
  ['get', `${base}/1/price`], ['get', `${base}/1/history`], ['get', '/api/v1/prices'], ['get', '/openapi.json'],
] as const)('%s %s requires authentication', async (method, path) => {
  await request(f.app)[method](path).expect(401);
  const wrong = await request(f.app)[method](path).set('Authorization', 'Bearer wrong-key').expect(401);
  expect(wrong.headers['www-authenticate']).toBe('Bearer');
  expect(wrong.body.error.requestId).toBeDefined();
});

test('OpenAPI has exactly the implemented operations with positive and negative responses', async () => {
  const doc = await request(f.app).get('/openapi.json').set(auth).expect(200);
  expect(doc.body.openapi).toBe('3.0.3');
  const operations = Object.values(doc.body.paths).flatMap(p => Object.values(p as object));
  expect(operations).toHaveLength(9);
  await request(f.app).get('/openapi.json?unexpected=1').set(auth).expect(400);
});

test.each([null, [], {}, { cmcId: '1' }, { cmcId: 1.5 }, { cmcId: -1 }, { cmcId: Number.MAX_SAFE_INTEGER + 1 },
  { cmcId: 1, other: 2 }])('creation rejects invalid body %j without provider calls', async body => {
  await request(f.app).post(base).set(auth).set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(400);
  expect(f.latest).not.toHaveBeenCalled();
});

test('malformed, oversized and wrong-content-type bodies get documented errors', async () => {
  await request(f.app).post(base).set(auth).set('Content-Type', 'application/json').send('{').expect(400);
  await request(f.app).post(base).set(auth).send('cmcId=1').expect(415);
  await request(f.app).post(base).set(auth).send({ name: 'a'.repeat(17000) }).expect(413);
});

test('invalid gzip bodies return a sanitized validation error without provider calls', async () => {
  const result = await request(f.app)
    .post(base)
    .set(auth)
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', 'gzip')
    .send('not a gzip body')
    .expect(400);

  expect(result.body).toEqual({
    error: {
      code: 'VALIDATION_ERROR',
      message: expect.any(String),
      requestId: result.headers['x-request-id'],
    },
  });
  expect(result.headers['x-request-id']).toBeDefined();
  expect(JSON.stringify([result.body, f.log.mock.calls])).not.toMatch(/incorrect header check|Z_DATA_ERROR|zlib/i);
  expect(f.latest).not.toHaveBeenCalled();
});

test('duplicate asset returns 409 without another provider call', async () => {
  await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(201);
  await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(409);
  expect(f.latest).toHaveBeenCalledTimes(1);
});

test('unknown and invalid provider assets leave no partial row', async () => {
  f.latest.mockResolvedValueOnce({ quotes: [], missingIds: [1], invalidIds: [] });
  await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(422);
  f.latest.mockResolvedValueOnce({ quotes: [], missingIds: [], invalidIds: [1] });
  await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(502);
  expect(f.repo.list({ limit: 100, offset: 0 })).toEqual([]);
});

test.each([502, 503, 504])('provider failure %i is mapped and creation is atomic', async status => {
  f.latest.mockRejectedValueOnce(new AppError(status, 'UPSTREAM_ERROR', 'Provider unavailable'));
  const result = await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(status);
  expect(result.body.error.message).toBe('Provider unavailable');
  expect(f.repo.hasCmc(1)).toBe(false);
});

test.each([undefined, 400])('unexpected errors with status %s remain sanitized internal errors', async status => {
  f.latest.mockRejectedValueOnce(Object.assign(new Error('a-private-key-and-stack'), { status }));
  const result = await request(f.app).post(base).set(auth).send({ cmcId: 1 }).expect(500);
  expect(result.body).toEqual({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: result.headers['x-request-id'],
    },
  });
  expect(JSON.stringify([result.body, f.log.mock.calls])).not.toContain('a-private-key-and-stack');
});

test('malformed URL parameters return a sanitized validation error', async () => {
  const result = await request(f.app).get(`${base}/%E0%A4%A`).set(auth).expect(400);

  expect(result.body).toEqual({
    error: {
      code: 'VALIDATION_ERROR',
      message: expect.any(String),
      requestId: result.headers['x-request-id'],
    },
  });
  expect(result.headers['x-request-id']).toBeDefined();
  expect(JSON.stringify([result.body, f.log.mock.calls])).not.toMatch(/Failed to decode param|URIError|%E0%A4%A/);
});

test.each(['-1', '1.5', '1abc', '9007199254740992', '1%20OR%201=1'])('invalid route ID %s is rejected', async id => {
  await request(f.app).get(`${base}/${id}`).set(auth).expect(400);
});

test.each(['limit=0', 'limit=101', 'offset=-1', 'limit=1&limit=2', 'wrong=1'])('invalid pagination %s is rejected', async query => {
  await request(f.app).get(`${base}?${query}`).set(auth).expect(400);
  await request(f.app).get(`/api/v1/prices?${query}`).set(auth).expect(400);
});

test('read, update, delete, price and history distinguish missing records', async () => {
  await request(f.app).get(`${base}/999`).set(auth).expect(404);
  await request(f.app).patch(`${base}/999`).set(auth).send({ name: 'Name' }).expect(404);
  await request(f.app).delete(`${base}/999`).set(auth).expect(404);
  await request(f.app).get(`${base}/999/price`).set(auth).expect(404);
  await request(f.app).get(`${base}/999/history`).set(auth).expect(404);
});

test.each([{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { cmcId: 2 }, { name: 'Name', symbol: 'X' }])(
  'patch rejects %j', async body => {
    const coin = f.repo.create(quote());
    await request(f.app).patch(`${base}/${coin.id}`).set(auth).send(body).expect(400);
    expect(f.repo.get(coin.id).name).toBe('Bitcoin');
  });

test.each(['\u0000Bitcoin', 'Bit\u0000coin'])('patch rejects NUL in %j without changing stored data', async name => {
  const coin = f.repo.create(quote());
  const page = { limit: 100, offset: 0 };
  const history = f.repo.history(coin.id, page);
  f.advance(1000);

  const result = await request(f.app).patch(`${base}/${coin.id}`).set(auth).send({ name }).expect(400);

  expect(result.body.error.code).toBe('VALIDATION_ERROR');
  expect(f.repo.get(coin.id)).toEqual(coin);
  expect(f.repo.history(coin.id, page)).toEqual(history);
});

test('history filters, pagination and empty results use only the selected coin', async () => {
  const coin = f.repo.create(quote()); f.repo.create(quote(2));
  f.repo.saveObservation(coin.id, quote(1, Date.parse('2026-10-23T10:05:00Z')));
  const result = await request(f.app).get(`${base}/${coin.id}/history?limit=1&from=2026-10-23T10:01:00Z`).set(auth).expect(200);
  expect(result.body.items).toHaveLength(1);
  expect(result.body.items[0].observedAt).toBe('2026-10-23T10:05:00.000Z');
  const empty = await request(f.app).get(`${base}/${coin.id}/history?to=2020-01-01T00:00:00Z`).set(auth).expect(200);
  expect(empty.body.items).toEqual([]);
  await request(f.app).get(`${base}/${coin.id}/history?from=2026-02-30T00:00:00Z`).set(auth).expect(400);
  await request(f.app).get(`${base}/${coin.id}/history?from=2026-10-24T00:00:00Z&to=2026-10-23T00:00:00Z`).set(auth).expect(400);
});

test('fresh receipt of an old provider quote is stale; missing observations are explicit', async () => {
  const coin = f.repo.create({ ...quote(), sourceUpdatedAt: '2026-10-20T00:00:00.000Z' });
  const price = await request(f.app).get(`${base}/${coin.id}/price`).set(auth).expect(200);
  expect(price.body.stale).toBe(true);
  f.repo.db.prepare('DELETE FROM price_history WHERE cryptocurrency_id=?').run(coin.id);
  await request(f.app).get(`${base}/${coin.id}/price`).set(auth).expect(503);
  const prices = await request(f.app).get('/api/v1/prices').set(auth).expect(200);
  expect(prices.body.items[0].latestPrice).toBeNull();
});

test('empty lists and unknown routes', async () => {
  const coins = await request(f.app).get(base).set(auth).expect(200);
  expect(coins.body.items).toEqual([]);
  await request(f.app).get('/missing').set(auth).expect(404);
});
