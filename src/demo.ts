/** No-account walkthrough. Synthetic quotes are injected only in this demo entry point. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './app';
import { Repository } from './repository';
import { TrackerService } from './service';
import { Scheduler } from './scheduler';
import { PriceProvider } from './types';

async function demo() {
  const directory = mkdtempSync(join(tmpdir(), 'evercode-demo-'));
  const file = join(directory, 'demo.sqlite');
  const repo = new Repository(file);
  const token = randomBytes(24).toString('hex'); // Ephemeral; never printed or written to a file.
  let round = 0;
  const provider: PriceProvider = { latest: async ids => {
    round++;
    return { quotes: ids.map(id => ({ cmcId: id, symbol: id === 1 ? 'BTC' : 'ETH',
      name: id === 1 ? 'Bitcoin' : 'Ethereum', price: 100 + id + round / 10,
      observedAt: new Date().toISOString(), sourceUpdatedAt: new Date().toISOString() })),
      missingIds: [], invalidIds: [] };
  } };
  const service = new TrackerService(repo, provider, 900000, Date.now, () => {});
  const app = createApp(service, token, () => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const scheduler = new Scheduler(signal => service.synchronize(signal), 1000, () => {});
  async function call(method: string, path: string, body?: unknown, authorized = true) {
    const response = await fetch(baseURL + path, { method,
      headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const content = await response.text();
    console.log(`${method} ${path} -> ${response.status}`);
    if (content) console.log(JSON.stringify(JSON.parse(content), null, 2));
    return content ? JSON.parse(content) : undefined;
  }
  try {
    console.log('DEMO: all prices are synthetic. No CoinMarketCap key or Docker is used.');
    const base = '/api/v1/cryptocurrencies';
    await call('GET', base, undefined, false);
    const coin = await call('POST', base, { cmcId: 1 });
    await call('GET', base);
    await call('PATCH', `${base}/${coin.id}`, { name: 'My Bitcoin' });
    scheduler.start();
    // Wait for the actual background job result, with a bounded polling window.
    for (let n = 0; n < 100 && repo.history(coin.id, { limit: 10, offset: 0 }).length < 2; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (repo.history(coin.id, { limit: 10, offset: 0 }).length < 2) throw new Error('Background demo did not complete');
    await scheduler.stop();
    await call('GET', `${base}/${coin.id}/price`);
    await call('GET', `${base}/${coin.id}/history`);
    const secondConnection = new Repository(file);
    console.log(`Persistence check: another SQLite connection reads ${secondConnection.get(coin.id).name}`);
    secondConnection.close();
    await call('DELETE', `${base}/${coin.id}`);
    await call('GET', `${base}/${coin.id}`);
    console.log('Demo finished; temporary database removed.');
  } finally {
    await scheduler.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    repo.close(); rmSync(directory, { recursive: true, force: true });
  }
}
void demo().catch(error => { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exitCode = 1; });
