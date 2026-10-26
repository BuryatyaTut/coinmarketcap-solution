import { AppError, unavailable } from './errors';
import { Repository } from './repository';
import { Clock, Logger, Observation, PriceProvider } from './types';

export class TrackerService {
  private readonly creating = new Set<number>();

  constructor(
    readonly repo: Repository,
    private readonly provider: PriceProvider,
    private readonly staleAfterMs: number,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async create(cmcId: number, signal?: AbortSignal) {
    if (signal?.aborted) throw unavailable();
    if (this.creating.has(cmcId) || this.repo.hasCmc(cmcId)) {
      throw new AppError(409, 'ALREADY_TRACKED', 'This cryptocurrency is already tracked or being added');
    }

    this.creating.add(cmcId);
    try {
      const result = await this.provider.latest([cmcId], signal);
      if (signal?.aborted) throw unavailable();
      if (result.invalidIds.includes(cmcId)) {
        throw new AppError(502, 'UPSTREAM_INVALID', 'Provider returned invalid price data');
      }

      const quote = result.quotes.find(quote => quote.cmcId === cmcId);
      if (!quote) {
        throw new AppError(422, 'UNKNOWN_ASSET', 'CoinMarketCap asset ID not found');
      }
      return this.repo.create(quote);
    } finally {
      this.creating.delete(cmcId);
    }
  }

  withFreshness(observation: Observation | null) {
    if (!observation) return null;
    const now = this.clock();
    const stale = now - Date.parse(observation.observedAt) > this.staleAfterMs
      || now - Date.parse(observation.sourceUpdatedAt) > this.staleAfterMs;
    return { ...observation, stale };
  }

  latest(id: number) {
    this.repo.get(id);
    const result = this.withFreshness(this.repo.latest(id));
    if (!result) {
      throw new AppError(503, 'PRICE_UNAVAILABLE', 'No price observation is available');
    }
    return result;
  }

  rename(id: number, name: string) {
    return this.repo.rename(id, name, new Date(this.clock()).toISOString());
  }

  async synchronize(signal: AbortSignal): Promise<void> {
    let after = 0;
    let saved = 0;
    let skipped = 0;

    // Keyset batches bound memory and external request size. SQLite remains authoritative.
    while (!signal.aborted) {
      const coins = this.repo.batchAfter(after);
      if (!coins.length) break;
      after = coins[coins.length - 1].id;
      const result = await this.provider.latest(coins.map(coin => coin.cmcId), signal);
      if (signal.aborted) break;
      skipped += result.invalidIds.length + result.missingIds.length;
      for (const quote of result.quotes) {
        const coin = coins.find(coin => coin.cmcId === quote.cmcId);
        if (coin && this.repo.saveObservation(coin.id, quote)) {
          saved++;
        }
      }
    }
    this.log('sync_finished', { saved, skipped, aborted: signal.aborted });
  }
}
