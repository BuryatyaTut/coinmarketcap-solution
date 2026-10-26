import { Repository } from '../src/repository';
import { fixture, quote } from './helpers';
let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

test('file-backed database survives a second connection and migration does not reset it', () => {
  const coin = f.repo.create(quote());
  const reopened = new Repository(f.file);
  try { expect(reopened.get(coin.id).cmcId).toBe(1); expect(reopened.latest(coin.id)?.price).toBe(12.345); }
  finally { reopened.close(); }
});

test('duplicate symbols remain distinct, duplicate CMC IDs fail', () => {
  const a = f.repo.create(quote());
  const b = f.repo.create({ ...quote(2), symbol: 'BTC' });
  expect(a.id).not.toBe(b.id);
  expect(() => f.repo.create(quote())).toThrow('already tracked');
});

test('a failure after insertion rolls back both observation and timestamp update', () => {
  const coin = f.repo.create(quote());
  f.repo.db.exec("CREATE TRIGGER fail_timestamp BEFORE UPDATE ON cryptocurrencies BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
  expect(() => f.repo.saveObservation(coin.id, quote(1, Date.now()))).toThrow('test failure');
  expect(f.repo.history(coin.id, { limit: 100, offset: 0 })).toHaveLength(1);
  expect(f.repo.get(coin.id).lastPriceAt).toBe(coin.lastPriceAt);
});

test('initial price failure rolls back coin creation', () => {
  expect(() => f.repo.create({ ...quote(), price: -1 })).toThrow();
  expect(f.repo.hasCmc(1)).toBe(false);
});

test('foreign key, currency and finite-price constraints reject invalid data', () => {
  const coin = f.repo.create(quote());
  const insert = f.repo.db.prepare('INSERT INTO price_history(cryptocurrency_id,price,currency,observed_at,source_updated_at) VALUES(?,?,?,?,?)');
  expect(() => insert.run(999, 1, 'USD', 'a', 'a')).toThrow();
  expect(() => insert.run(coin.id, 1, 'EUR', 'a', 'a')).toThrow();
  expect(() => insert.run(coin.id, Infinity, 'USD', 'a', 'a')).toThrow();
});

test('delete and recreate never reuse identity or accept an old pending observation', () => {
  const first = f.repo.create(quote()); f.repo.delete(first.id);
  const second = f.repo.create(quote());
  expect(second.id).toBeGreaterThan(first.id);
  expect(f.repo.saveObservation(first.id, quote())).toBe(false);
  expect(f.repo.history(second.id, { limit: 100, offset: 0 })).toHaveLength(1);
});

test('equal observation times use descending IDs as a stable tie-breaker', () => {
  const coin = f.repo.create(quote());
  f.repo.saveObservation(coin.id, { ...quote(), price: 99 });
  expect(f.repo.latest(coin.id)?.price).toBe(99);
});
