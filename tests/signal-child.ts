// Subprocess fixture: exercises the real signal handlers without any external network.
import { startServer, installSignalHandlers } from '../src/server';
import { Config } from '../src/config';
import { PriceProvider, logger } from '../src/types';
import { unavailable } from '../src/errors';

const config: Config = { apiToken: 'test-only-application-token', cmcKey: 'test-provider-key', host: '127.0.0.1',
  port: 0, dbPath: process.argv[2], intervalMs: 1000, staleAfterMs: 900000, timeoutMs: 1000,
  shutdownMs: process.argv[3] === 'http' ? 1000 : 200 };
const provider: PriceProvider = { latest: (_ids, signal) => new Promise((_resolve, reject) => {
  logger('provider_waiting');
  if (process.argv[3] !== 'uncooperative') signal?.addEventListener('abort', () => reject(unavailable()), { once: true });
}) };
void startServer(config, logger, provider).then(running => {
  installSignalHandlers(running.stop);
  logger('ready', { port: (running.server.address() as { port: number }).port });
}).catch(() => { process.exitCode = 1; });
