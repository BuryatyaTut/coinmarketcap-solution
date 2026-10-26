import { loadConfig } from '../src/config';
import { timestamp } from '../src/validation';
const env = { APP_API_TOKEN: 'test-only-application-token', CMC_API_KEY: 'test-provider-key' };
test('loads safe defaults and validates all supplied settings', () => {
  expect(loadConfig(env).host).toBe('127.0.0.1');
  for (const bad of [ { APP_API_TOKEN: '' }, { CMC_API_KEY: '' }, { DB_PATH: ':memory:' }, { PORT: '3abc' },
    { SYNC_INTERVAL_MS: '0' }, { STALE_AFTER_MS: '1000' }, { HOST: 'example.com' }, { CMC_TIMEOUT_MS: '0' },
    { SHUTDOWN_TIMEOUT_MS: '0' }, { CMC_API_KEY: env.APP_API_TOKEN } ]) {
    expect(() => loadConfig({ ...env, ...bad })).toThrow();
  }
});
test('timestamp validation handles leap years, offsets and invalid calendars', () => {
  expect(timestamp('2024-02-29T12:00:00+03:00')).toBe('2024-02-29T09:00:00.000Z');
  for (const value of ['2026-02-29T00:00:00Z', '2024-13-01T00:00:00Z', '2024-01-01T24:00:00Z',
    '2024-01-01T00:00:00', '2024-01-01T00:00:00+24:00', '', ['2024-01-01T00:00:00Z']]) {
    expect(() => timestamp(value)).toThrow();
  }
});
