import { AppError } from '../src/errors';
import { Scheduler } from '../src/scheduler';
import { fixture, quote } from './helpers';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
afterEach(() => jest.useRealTimers());

test('scheduler starts immediately, waits after completion and never overlaps', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  const work = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const scheduler = new Scheduler(work, 1000, jest.fn());
  scheduler.start(); scheduler.start();
  jest.advanceTimersByTime(10000); expect(work).toHaveBeenCalledTimes(1);
  release(); await flush();
  jest.advanceTimersByTime(999); expect(work).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1); expect(work).toHaveBeenCalledTimes(2);
  release(); await flush(); await scheduler.stop();
  jest.advanceTimersByTime(10000); expect(work).toHaveBeenCalledTimes(2);
});

test('failure recovers on next run and rate limits defer the next attempt', async () => {
  jest.useFakeTimers();
  const work = jest.fn().mockRejectedValueOnce(new AppError(503, 'RATE_LIMIT', 'Wait', 5000)).mockResolvedValue(undefined);
  const log = jest.fn(); const scheduler = new Scheduler(work, 1000, log);
  scheduler.start(); await flush();
  jest.advanceTimersByTime(4999); expect(work).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1); await flush(); expect(work).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenCalledWith('sync_failed', { code: 'RATE_LIMIT' });
  await scheduler.stop();
});

test('stop aborts in-flight work and does not re-arm a timer', async () => {
  jest.useFakeTimers();
  const work = jest.fn((signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
  const scheduler = new Scheduler(work, 1000, jest.fn()); scheduler.start();
  await scheduler.stop(); await scheduler.stop();
  scheduler.start(); jest.advanceTimersByTime(10000);
  expect(work).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('sync skips empty DB and stores real observations without overwriting display name', async () => {
  const f = fixture();
  try {
    const signal = new AbortController().signal;
    await f.service.synchronize(signal); expect(f.latest).not.toHaveBeenCalled();
    const coin = f.repo.create(quote()); f.service.rename(coin.id, 'My name'); f.advance(5000);
    await f.service.synchronize(signal);
    expect(f.repo.history(coin.id, { limit: 100, offset: 0 })).toHaveLength(2);
    expect(f.repo.get(coin.id).name).toBe('My name');
    expect(f.repo.get(coin.id).lastPriceAt).not.toBe(coin.lastPriceAt);
  } finally { f.cleanup(); }
});

test('partial response keeps old data for invalid/missing coins', async () => {
  const f = fixture();
  try {
    const a = f.repo.create(quote()), b = f.repo.create(quote(2));
    f.latest.mockResolvedValueOnce({ quotes: [quote()], missingIds: [], invalidIds: [2] });
    await f.service.synchronize(new AbortController().signal);
    expect(f.repo.history(a.id, { limit: 100, offset: 0 })).toHaveLength(2);
    expect(f.repo.history(b.id, { limit: 100, offset: 0 })).toHaveLength(1);
    expect(f.log).toHaveBeenCalledWith('sync_finished', { saved: 1, skipped: 1, aborted: false });
  } finally { f.cleanup(); }
});

test('delete during fetch and cancellation cannot create late writes', async () => {
  const f = fixture();
  try {
    const coin = f.repo.create(quote());
    f.latest.mockImplementationOnce(async () => {
      f.repo.delete(coin.id); f.repo.create(quote());
      return { quotes: [quote()], missingIds: [], invalidIds: [] };
    });
    await f.service.synchronize(new AbortController().signal);
    const replacement = f.repo.list({ limit: 10, offset: 0 })[0];
    // Replacement may be picked up by the next batch; it must never receive the old local ID's write.
    expect(f.repo.latest(coin.id)).toBeNull();
    expect(replacement.id).not.toBe(coin.id);
    const controller = new AbortController();
    const before = f.repo.history(replacement.id, { limit: 100, offset: 0 }).length;
    f.latest.mockImplementationOnce(async () => { controller.abort(); return { quotes: [quote()], missingIds: [], invalidIds: [] }; });
    await f.service.synchronize(controller.signal);
    expect(f.repo.history(replacement.id, { limit: 100, offset: 0 })).toHaveLength(before);
  } finally { f.cleanup(); }
});
