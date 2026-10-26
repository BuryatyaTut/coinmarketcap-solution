import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/repository';
import { TrackerService } from '../src/service';
import { createApp } from '../src/app';
import { Quote, QuoteResult } from '../src/types';

export const TOKEN = 'test-only-application-key';
export const NOW = Date.parse('2026-10-23T10:00:00.000Z');
export function quote(id = 1, now = NOW): Quote {
  return { cmcId: id, symbol: id === 1 ? 'BTC' : 'ETH', name: id === 1 ? 'Bitcoin' : 'Ethereum',
    price: id * 12.345, observedAt: new Date(now).toISOString(), sourceUpdatedAt: new Date(now - 1000).toISOString() };
}
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'evercode-test-'));
  const file = join(directory, 'test.sqlite');
  const repo = new Repository(file);
  let now = NOW;
  const latest = jest.fn(async (ids: number[], _signal?: AbortSignal): Promise<QuoteResult> => ({
    quotes: ids.map(id => quote(id, now)), missingIds: [], invalidIds: [],
  }));
  const log = jest.fn();
  const service = new TrackerService(repo, { latest }, 900000, () => now, log);
  const app = createApp(service, TOKEN, log);
  return { directory, file, repo, latest, log, service, app, advance: (ms: number) => { now += ms; },
    cleanup: () => { repo.close(); rmSync(directory, { recursive: true, force: true }); } };
}
