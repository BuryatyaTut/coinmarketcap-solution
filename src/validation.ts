import { invalid } from './errors';
import { HistoryFilter, Page } from './types';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw invalid('Unexpected input field');
  }
}

export function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function trimmedText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw invalid(`${name} must be text without null characters`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw invalid(`${name} must contain 1–${maxLength} characters after trimming`);
  }
  return trimmed;
}

export function createBody(value: unknown): number {
  const body = object(value);
  keys(body, ['cmcId']);
  if (typeof body.cmcId !== 'number') {
    throw invalid('cmcId must be a JSON number');
  }
  return integer(body.cmcId, 'cmcId');
}

export function updateBody(value: unknown): string {
  const body = object(value);
  keys(body, ['name']);
  return trimmedText(body.name, 'name', 120);
}

// Date.parse alone normalizes impossible dates such as February 30. Validate the components first.
export function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalid('Expected a timestamp with a timezone');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw invalid('Use an ISO timestamp with seconds and an explicit timezone');
  const [, yearText, monthText, dayText, hour, minute, second, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    throw invalid('Invalid calendar timestamp');
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch < Date.parse('0001-01-01T00:00:00Z')
    || epoch > Date.parse('9999-12-31T23:59:59.999Z')) {
    throw invalid('Timestamp out of range');
  }
  return new Date(epoch).toISOString();
}

export function pagination(query: Record<string, unknown>, history = false): HistoryFilter {
  keys(query, history ? ['limit', 'offset', 'from', 'to'] : ['limit', 'offset']);
  const page: HistoryFilter = {
    limit: query.limit === undefined ? 50 : integer(query.limit, 'limit', 1, 100),
    offset: query.offset === undefined ? 0 : integer(query.offset, 'offset', 0),
  };
  if (history) {
    if (query.from !== undefined) page.from = timestamp(query.from);
    if (query.to !== undefined) page.to = timestamp(query.to);
    if (page.from && page.to && page.from > page.to) throw invalid('from must not be after to');
  }
  return page;
}

export function pageResult<T>(items: T[], page: Page) {
  return { items, limit: page.limit, offset: page.offset };
}
