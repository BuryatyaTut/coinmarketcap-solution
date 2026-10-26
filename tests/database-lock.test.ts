import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import { fixture, quote, TOKEN } from './helpers';

test('an external write lock returns a retryable error promptly and leaves reads usable', async () => {
  const f = fixture();
  const coin = f.repo.create(quote());
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const url = `/api/v1/cryptocurrencies/${coin.id}`;
  const locker = new DatabaseSync(f.file);
  try {
    locker.exec('BEGIN IMMEDIATE');
    try {
      const started = performance.now();
      const [write, read] = await Promise.all([
        request(f.app).patch(url).set(auth).send({ name: 'Renamed' }),
        request(f.app).get(url).set(auth),
      ]);
      expect(performance.now() - started).toBeLessThan(500);
      expect(write.status).toBe(503);
      expect(write.headers['retry-after']).toBe('1');
      expect(write.body).toEqual({ error: {
        code: 'DATABASE_BUSY', message: 'Database is busy; retry shortly',
        requestId: write.headers['x-request-id'],
      } });
      expect(read.status).toBe(200);
      expect(read.body).toEqual(coin);
      await request(f.app).delete(url).set(auth).expect(503);
      await request(f.app).post('/api/v1/cryptocurrencies').set(auth).send({ cmcId: 2 }).expect(503);
      expect(f.repo.hasCmc(2)).toBe(false);
      expect(f.repo.history(coin.id, { limit: 100, offset: 0 })).toHaveLength(1);
      expect(JSON.stringify(f.log.mock.calls)).not.toContain('database is locked');
    } finally {
      locker.exec('ROLLBACK');
    }

    const updated = await request(f.app).patch(url).set(auth).send({ name: 'Renamed' }).expect(200);
    expect(updated.body.name).toBe('Renamed');
    await request(f.app).post('/api/v1/cryptocurrencies').set(auth).send({ cmcId: 2 }).expect(201);
    await request(f.app).delete(url).set(auth).expect(204);
    expect(f.repo.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(f.repo.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    locker.close();
    f.cleanup();
  }
});
