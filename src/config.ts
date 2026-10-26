import { resolve } from 'node:path';

export interface Config {
  apiToken: string;
  cmcKey: string;
  host: string;
  port: number;
  dbPath: string;
  intervalMs: number;
  staleAfterMs: number;
  timeoutMs: number;
  shutdownMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function secret(name: string, min: number): string {
    const value = env[name] ?? '';
    if (value.length < min || value.length > 512 || /\s/.test(value)) {
      throw new Error(`Set a valid ${name}`);
    }
    return value;
  }

  function number(name: string, fallback: number, min: number, max: number): number {
    const value = env[name] ?? String(fallback);
    const result = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) {
      throw new Error(`Invalid ${name}`);
    }
    return result;
  }

  const file = env.DB_PATH ?? './data/prices.sqlite';
  if (!file.trim() || file.includes(':') || file.includes('\0')) {
    throw new Error('DB_PATH must be a file path');
  }

  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) {
    throw new Error('Invalid HOST');
  }

  const config: Config = {
    apiToken: secret('APP_API_TOKEN', 16),
    cmcKey: secret('CMC_API_KEY', 1),
    host,
    port: number('PORT', 3000, 1, 65535),
    dbPath: resolve(file),
    intervalMs: number('SYNC_INTERVAL_MS', 300000, 1000, 86400000),
    staleAfterMs: number('STALE_AFTER_MS', 900000, 1000, 604800000),
    timeoutMs: number('CMC_TIMEOUT_MS', 5000, 100, 30000),
    shutdownMs: number('SHUTDOWN_TIMEOUT_MS', 10000, 1000, 60000),
  };
  if (config.staleAfterMs < config.intervalMs) {
    throw new Error('STALE_AFTER_MS must be >= SYNC_INTERVAL_MS');
  }
  if (config.apiToken === config.cmcKey) {
    throw new Error('Use separate application and provider keys');
  }
  return config;
}
