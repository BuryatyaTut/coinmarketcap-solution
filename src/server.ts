import { Server } from 'node:http';
import { createApp } from './app';
import { CoinMarketCapClient } from './coinmarketcap';
import { Config, loadConfig } from './config';
import { Repository } from './repository';
import { Scheduler } from './scheduler';
import { TrackerService } from './service';
import { Logger, PriceProvider, logger } from './types';

export async function startServer(
  config: Config,
  log: Logger = logger,
  provider: PriceProvider = new CoinMarketCapClient(config.cmcKey, config.timeoutMs),
) {
  const repo = new Repository(config.dbPath);
  const service = new TrackerService(repo, provider, config.staleAfterMs, Date.now, log);
  const shutdownController = new AbortController();
  const app = createApp(service, config.apiToken, log, shutdownController.signal);
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(config.port, config.host);
      listener.once('listening', () => {
        listener.off('error', reject);
        resolve(listener);
      });
      listener.once('error', reject);
    });
  } catch (error) {
    repo.close();
    throw error;
  }

  server.on('request', (_request, response) => {
    response.once('finish', () => {
      // A request active at server.close() may become an idle keep-alive connection later.
      if (shutdownController.signal.aborted) setImmediate(() => server.closeIdleConnections());
    });
  });

  const scheduler = new Scheduler(signal => service.synchronize(signal), config.intervalMs, log);
  scheduler.start();

  let stopping: Promise<boolean> | undefined;
  function stop(): Promise<boolean> {
    if (stopping) return stopping;
    stopping = (async () => {
      shutdownController.abort();
      let timeout: ReturnType<typeof setTimeout>;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      const complete = Promise.all([closed, scheduler.stop()]).then(() => true);
      const deadline = new Promise<false>(resolve => {
        timeout = setTimeout(() => {
          server.closeAllConnections();
          resolve(false);
        }, config.shutdownMs);
      });
      const drained = await Promise.race([complete, deadline]);
      clearTimeout(timeout!);
      // On timeout, leave DB closure to process termination: do not close underneath a writer.
      if (drained) repo.close();
      log('shutdown_finished', { drained });
      return drained;
    })();
    return stopping;
  }

  log('listening', {
    port: (server.address() as { port: number }).port,
    host: config.host,
  });
  return { server, stop };
}

export function installSignalHandlers(stop: () => Promise<boolean>): void {
  let handlingSignal = false;
  const onSignal = () => {
    if (handlingSignal) return;
    handlingSignal = true;
    void stop()
      .then(drained => {
        if (!drained) process.exit(1);
      })
      .catch(() => {
        logger('shutdown_failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

if (require.main === module) {
  void (async () => {
    try {
      const running = await startServer(loadConfig());
      installSignalHandlers(running.stop);
    } catch {
      logger('startup_failed', {
        hint: 'Check Node version, environment configuration, port and database path',
      });
      process.exitCode = 1;
    }
  })();
}
