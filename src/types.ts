export interface Cryptocurrency {
  id: number;
  cmcId: number;
  symbol: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastPriceAt: string | null;
}

export interface Observation {
  id: number;
  cryptocurrencyId: number;
  price: number;
  currency: 'USD';
  observedAt: string;
  sourceUpdatedAt: string;
}

export interface Quote {
  cmcId: number;
  symbol: string;
  name: string;
  price: number;
  observedAt: string;
  sourceUpdatedAt: string;
}

export interface QuoteResult {
  quotes: Quote[];
  missingIds: number[];
  invalidIds: number[];
}

export interface PriceProvider {
  latest(ids: number[], signal?: AbortSignal): Promise<QuoteResult>;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface HistoryFilter extends Page {
  from?: string;
  to?: string;
}

export type Clock = () => number;
export type Logger = (event: string, fields?: Record<string, string | number | boolean>) => void;

export const logger: Logger = (event, fields = {}) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};
