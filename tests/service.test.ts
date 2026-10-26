import { unavailable } from '../src/errors';
import { QuoteResult } from '../src/types';
import { fixture, quote } from './helpers';

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

test('ten simultaneous creates for one asset make one provider call and save one observation', async () => {
  let release!: (result: QuoteResult) => void;
  f.latest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

  const pending = Promise.allSettled(Array.from({ length: 10 }, () => f.service.create(1)));
  expect(f.latest).toHaveBeenCalledTimes(1);
  release({ quotes: [quote()], missingIds: [], invalidIds: [] });

  const results = await pending;
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.filter(result => result.status === 'rejected');
  expect(rejected).toHaveLength(9);
  for (const result of rejected) {
    expect(result.reason).toMatchObject({ status: 409, code: 'ALREADY_TRACKED' });
  }
  const coins = f.repo.list({ limit: 100, offset: 0 });
  expect(coins).toHaveLength(1);
  expect(f.repo.history(coins[0].id, { limit: 100, offset: 0 })).toHaveLength(1);

  f.repo.delete(coins[0].id);
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});

test('creating one asset does not block a different asset', async () => {
  let release!: (result: QuoteResult) => void;
  f.latest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));

  const first = f.service.create(1);
  await expect(f.service.create(2)).resolves.toMatchObject({ cmcId: 2 });
  expect(f.repo.hasCmc(1)).toBe(false);
  expect(f.latest).toHaveBeenCalledTimes(2);
  release({ quotes: [quote()], missingIds: [], invalidIds: [] });
  await expect(first).resolves.toMatchObject({ cmcId: 1 });
});

test('provider rejection releases the asset for a later retry', async () => {
  f.latest.mockRejectedValueOnce(new Error('Provider failed'));
  await expect(f.service.create(1)).rejects.toThrow('Provider failed');
  expect(f.repo.hasCmc(1)).toBe(false);
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});

test.each([
  { invalidIds: [1], missingIds: [], status: 502 },
  { invalidIds: [], missingIds: [1], status: 422 },
])('invalid or missing quote ($status) releases the asset for retry', async ({ invalidIds, missingIds, status }) => {
  f.latest.mockResolvedValueOnce({ quotes: [], invalidIds, missingIds });
  await expect(f.service.create(1)).rejects.toMatchObject({ status });
  expect(f.repo.hasCmc(1)).toBe(false);
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});

test('a database write failure releases the asset for retry', async () => {
  const create = jest.spyOn(f.repo, 'create').mockImplementationOnce(() => { throw new Error('Write failed'); });
  await expect(f.service.create(1)).rejects.toThrow('Write failed');
  expect(f.repo.hasCmc(1)).toBe(false);
  create.mockRestore();
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});

test('provider cancellation releases the asset for retry', async () => {
  const controller = new AbortController();
  f.latest.mockImplementationOnce((_ids, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(unavailable()), { once: true });
  }));
  const stopped = expect(f.service.create(1, controller.signal)).rejects.toMatchObject({ code: 'STOPPING' });
  controller.abort();
  await stopped;
  expect(f.repo.hasCmc(1)).toBe(false);
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});

test('a quote arriving after cancellation is discarded and a later retry succeeds', async () => {
  const controller = new AbortController();
  let release!: (result: QuoteResult) => void;
  f.latest.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const stopped = expect(f.service.create(1, controller.signal)).rejects.toMatchObject({ code: 'STOPPING' });
  controller.abort();
  release({ quotes: [quote()], missingIds: [], invalidIds: [] });
  await stopped;
  expect(f.repo.hasCmc(1)).toBe(false);
  await expect(f.service.create(1)).resolves.toMatchObject({ cmcId: 1 });
  expect(f.latest).toHaveBeenCalledTimes(2);
});
