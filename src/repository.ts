import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AppError, notFound } from './errors';
import { Cryptocurrency, HistoryFilter, Observation, Page, Quote } from './types';

const COIN = 'id, cmc_id AS cmcId, symbol, name, created_at AS createdAt, updated_at AS updatedAt, last_price_at AS lastPriceAt';
const PRICE = 'id, cryptocurrency_id AS cryptocurrencyId, price, currency, observed_at AS observedAt, source_updated_at AS sourceUpdatedAt';

export class Repository {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file === ':memory:') throw new Error('Use a file-backed database');
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      // Synchronous lock waiting would block every HTTP request; let callers retry instead.
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;');
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (version === 0) {
        this.transaction(() => {
          this.db.exec(readFileSync(resolve(__dirname, '../../migrations/001_initial.sql'), 'utf8'));
          this.db.exec('PRAGMA user_version=1');
        });
      } else if (version !== 1) {
        throw new Error('Unsupported database schema version');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: number): Cryptocurrency {
    const row = this.db.prepare(`SELECT ${COIN} FROM cryptocurrencies WHERE id=?`).get(id);
    if (!row) throw notFound();
    return row as unknown as Cryptocurrency;
  }

  hasCmc(cmcId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM cryptocurrencies WHERE cmc_id=?').get(cmcId);
  }

  list(page: Page): Cryptocurrency[] {
    return this.db.prepare(`SELECT ${COIN} FROM cryptocurrencies ORDER BY id LIMIT ? OFFSET ?`)
      .all(page.limit, page.offset) as unknown as Cryptocurrency[];
  }

  batchAfter(id: number, limit = 100): Cryptocurrency[] {
    return this.db.prepare(`SELECT ${COIN} FROM cryptocurrencies WHERE id>? ORDER BY id LIMIT ?`)
      .all(id, limit) as unknown as Cryptocurrency[];
  }

  create(quote: Quote): Cryptocurrency {
    try {
      return this.transaction(() => {
        const result = this.db.prepare(`INSERT INTO cryptocurrencies
          (cmc_id,symbol,name,created_at,updated_at,last_price_at) VALUES(?,?,?,?,?,?)`)
          .run(
            quote.cmcId,
            quote.symbol,
            quote.name,
            quote.observedAt,
            quote.observedAt,
            quote.observedAt,
          );
        const id = Number(result.lastInsertRowid);
        this.insertPrice(id, quote);
        return this.get(id);
      });
    } catch (error) {
      if (this.hasCmc(quote.cmcId)) {
        throw new AppError(409, 'ALREADY_TRACKED', 'This cryptocurrency is already tracked');
      }
      throw error;
    }
  }

  rename(id: number, name: string, now: string): Cryptocurrency {
    const result = this.db.prepare('UPDATE cryptocurrencies SET name=?, updated_at=? WHERE id=?')
      .run(name, now, id);
    if (!result.changes) throw notFound();
    return this.get(id);
  }

  delete(id: number): void {
    const result = this.db.prepare('DELETE FROM cryptocurrencies WHERE id=?').run(id);
    if (!result.changes) throw notFound();
  }

  private insertPrice(id: number, quote: Quote): void {
    this.db.prepare(`INSERT INTO price_history(cryptocurrency_id,price,currency,observed_at,source_updated_at)
      VALUES(?,?,'USD',?,?)`).run(id, quote.price, quote.observedAt, quote.sourceUpdatedAt);
  }

  saveObservation(id: number, quote: Quote): boolean {
    return this.transaction(() => {
      const exists = this.db.prepare('SELECT 1 FROM cryptocurrencies WHERE id=? AND cmc_id=?').get(id, quote.cmcId);
      if (!exists) return false; // A pending fetch must never recreate a deleted asset.
      this.insertPrice(id, quote);
      this.db.prepare('UPDATE cryptocurrencies SET symbol=?, updated_at=?, last_price_at=? WHERE id=?')
        .run(quote.symbol, quote.observedAt, quote.observedAt, id);
      return true;
    });
  }

  latest(id: number): Observation | null {
    return (this.db.prepare(`SELECT ${PRICE} FROM price_history WHERE cryptocurrency_id=?
      ORDER BY observed_at DESC, id DESC LIMIT 1`).get(id) as unknown as Observation | undefined) ?? null;
  }

  history(id: number, filter: HistoryFilter): Observation[] {
    this.get(id);
    const conditions = ['cryptocurrency_id=?'];
    const values: SQLInputValue[] = [id];
    if (filter.from) {
      conditions.push('observed_at>=?');
      values.push(filter.from);
    }
    if (filter.to) {
      conditions.push('observed_at<=?');
      values.push(filter.to);
    }
    return this.db.prepare(`SELECT ${PRICE} FROM price_history WHERE ${conditions.join(' AND ')}
      ORDER BY observed_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, filter.limit, filter.offset) as unknown as Observation[];
  }
}
