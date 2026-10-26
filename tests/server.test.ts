import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fixture, quote } from './helpers';
import { startServer } from '../src/server';
import { Config } from '../src/config';

let f: ReturnType<typeof fixture>;
beforeEach(() => { f = fixture(); });
afterEach(() => f.cleanup());

test.each(['SIGINT', 'SIGTERM'] as const)('%s drains pending provider work and exits cleanly', async signal => {
  f.repo.create(quote());
  const child = spawn(process.execPath, [resolve(__dirname, 'signal-child.js'), f.file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  try {
    const exit = new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject); child.once('exit', code => resolveExit(code));
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    await new Promise<void>((ready, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('provider_waiting') && output.includes('ready')) ready(); });
      child.once('exit', () => reject(new Error(`Child exited early: ${errors}`)));
    });
    child.kill(signal);
    expect(await exit).toBe(0);
    expect(output).toContain('"drained":true');
    expect(f.repo.history(1, { limit: 100, offset: 0 })).toHaveLength(1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('shutdown deadline exits with failure for uncooperative work', async () => {
  f.repo.create(quote());
  const child = spawn(process.execPath, [resolve(__dirname, 'signal-child.js'), f.file, 'uncooperative'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    const exit = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
    await new Promise<void>((ready, reject) => {
      child.once('error', reject);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('provider_waiting') && output.includes('ready')) ready(); });
      child.once('exit', () => reject(new Error('Child exited before ready')));
    });
    child.kill('SIGTERM');
    expect(await exit).toBe(1); expect(output).toContain('"drained":false');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('idle server shutdown is idempotent and closes HTTP', async () => {
  const config: Config = { apiToken: 'test-application-token', cmcKey: 'test-provider-key', host: '127.0.0.1', port: 0,
    dbPath: f.file, intervalMs: 1000, staleAfterMs: 900000, timeoutMs: 1000, shutdownMs: 1000 };
  const running = await startServer(config, f.log, { latest: f.latest });
  const a = running.stop(), b = running.stop();
  expect(a).toBe(b); expect(await a).toBe(true); expect(running.server.listening).toBe(false);
});

test.each(['SIGINT', 'SIGTERM'] as const)('%s drains an active keep-alive response within one second', async signal => {
  const child = spawn(process.execPath, [resolve(__dirname, 'signal-child.js'), f.file, 'http'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exit = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  function waitFor(event: string): Promise<{ port: number }> {
    return new Promise((resolveEvent, reject) => {
      const check = () => {
        const line = output.split('\n').slice(0, -1).find(value => value.includes(`"event":"${event}"`));
        if (!line) return;
        child.stdout.off('data', check);
        child.off('exit', earlyExit);
        resolveEvent(JSON.parse(line));
      };
      const earlyExit = () => reject(new Error(`Child exited before ${event}`));
      child.stdout.on('data', check);
      child.once('exit', earlyExit);
      check();
    });
  }
  child.stdout.on('data', chunk => { output += chunk; });
  try {
    const { port } = await waitFor('ready');
    const response = fetch(`http://127.0.0.1:${port}/api/v1/cryptocurrencies`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-only-application-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmcId: 1 }),
      signal: AbortSignal.timeout(3000),
    });
    await waitFor('provider_waiting');
    child.kill(signal);
    const stopped = await response;
    expect(stopped.status).toBe(503);
    expect((await stopped.json()).error.code).toBe('STOPPING');
    expect(await exit).toBe(0);
    expect(output).toContain('"drained":true');
    expect(f.repo.list({ limit: 10, offset: 0 })).toHaveLength(0);
    expect(f.repo.db.prepare('SELECT count(*) AS total FROM price_history').get()?.total).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exit;
  }
});
