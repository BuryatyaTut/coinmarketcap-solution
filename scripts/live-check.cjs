// One outbound request at most. No Scheduler is constructed by this check.
// Never log axios errors/configuration: they can contain the provider credential.
const assert = require('node:assert/strict');
const { writeFileSync, copyFileSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const axios = require('axios');
const { loadConfig } = require('../dist/src/config');
const { CoinMarketCapClient } = require('../dist/src/coinmarketcap');
const { Repository } = require('../dist/src/repository');
const { TrackerService } = require('../dist/src/service');
const { createApp } = require('../dist/src/app');
const { AppError } = require('../dist/src/errors');

async function main() {
  const report = { startedAt: new Date().toISOString(), success: false,
    provider: { endpoint: 'https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest',
      cmcIds: [1], currency: 'USD', requestBudget: 1, requests: 0,
      blockedRetries: 0, httpStatus: null, errorCode: null, credits: null },
    scheduledPolling: false, checks: {}, serverStopped: true };
  let repo, server, stage = 'configuration';
  const stop = new AbortController();
  const deadline = setTimeout(() => { stop.abort(); server?.closeAllConnections(); }, 45000);
  const quiet = () => {};
  try {
    const config = loadConfig();
    const transport = axios.create({ baseURL: 'https://pro-api.coinmarketcap.com',
      maxRedirects: 0, maxContentLength: 2 * 1024 * 1024 });
    const http = { async get(path, options) {
      if (report.provider.requests >= 1) {
        report.provider.blockedRetries++;
        throw new AppError(503, 'LIVE_CHECK_BUDGET', 'Single-request budget reached');
      }
      assert.equal(path, '/v3/cryptocurrency/quotes/latest');
      assert.equal(options.params.id, '1');
      report.provider.requests++;
      let response;
      try { response = await transport.get(path, options); }
      catch (error) {
        report.provider.httpStatus = error.response?.status ?? null;
        const code = error.response?.data?.status?.error_code;
        report.provider.errorCode = typeof code === 'number' ? code : null;
        throw error;
      }
      report.provider.httpStatus = response.status;
      const status = response.data?.status;
      report.provider.errorCodePresent = Object.hasOwn(status ?? {}, 'error_code');
      report.provider.errorCodeType = status?.error_code === null ? 'null' : typeof status?.error_code;
      report.provider.errorMessageEmpty = status?.error_message == null || status.error_message === '';
      report.provider.errorCode = typeof status?.error_code === 'number'
        || (typeof status?.error_code === 'string' && /^\d{1,6}$/.test(status.error_code)) ? status.error_code : null;
      report.provider.credits = typeof status?.credit_count === 'number' ? status.credit_count : null;
      report.provider.dataShape = Array.isArray(response.data?.data) ? 'array' : typeof response.data?.data;
      const btc = Array.isArray(response.data?.data) ? response.data.data.find(item => item.id === 1) : null;
      const usd = Array.isArray(btc?.quote) ? btc.quote.find(item => item.symbol === 'USD') : null;
      report.provider.priceUsd = typeof usd?.price === 'number' ? usd.price : null;
      report.provider.quoteTimestamp = typeof usd?.last_updated === 'string' ? usd.last_updated : null;
      // Keep only bounded public quote fields, never headers, config, or raw errors.
      if (btc && usd && typeof btc.name === 'string' && typeof btc.symbol === 'string') {
        const fixture = { status: { error_code: report.provider.errorCode, credit_count: report.provider.credits },
          data: [{ id: 1, name: btc.name.slice(0, 120), symbol: btc.symbol.slice(0, 64),
            quote: [{ symbol: 'USD', price: report.provider.priceUsd,
              last_updated: report.provider.quoteTimestamp }] }] };
        writeFileSync(resolve(__dirname, '../docs/live-response-sample.json'), JSON.stringify(fixture, null, 2) + '\n');
      }
      return response;
    } };
    const provider = new CoinMarketCapClient(config.cmcKey, config.timeoutMs, Date.now, http);
    stage = 'database';
    repo = new Repository(config.dbPath);
    const service = new TrackerService(repo, provider, config.staleAfterMs, Date.now, quiet);
    const app = createApp(service, config.apiToken, quiet, stop.signal);
    stage = 'listen';
    server = await new Promise((ok, fail) => {
      const listener = app.listen(0, '127.0.0.1', () => ok(listener));
      listener.once('error', fail);
    });
    report.serverStopped = false;
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, method = 'GET', body, authenticated = true) {
      const headers = authenticated ? { Authorization: `Bearer ${config.apiToken}` } : {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, { method, headers, signal: stop.signal,
        body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }
    const route = '/api/v1/cryptocurrencies';
    stage = 'authentication';
    report.checks.unauthenticatedStatus = (await request(route, 'GET', undefined, false)).status;
    assert.equal(report.checks.unauthenticatedStatus, 401);
    const existing = repo.db.prepare('SELECT id FROM cryptocurrencies WHERE cmc_id=1').get();
    let coin;
    stage = 'live_quote';
    if (existing) {
      const result = await provider.latest([1], stop.signal);
      assert.equal(result.quotes.length, 1);
      assert.equal(repo.saveObservation(existing.id, result.quotes[0]), true);
      coin = repo.get(existing.id);
      report.checks.creation = 'Reused existing Bitcoin; saved one new live observation';
    } else {
      const created = await request(route, 'POST', { cmcId: 1 });
      report.checks.createStatus = created.status;
      if (created.status !== 201) {
        throw new AppError(created.status, created.body.error?.code ?? 'CREATE_FAILED', 'Live creation failed');
      }
      coin = created.body;
    }
    report.asset = { id: coin.id, cmcId: coin.cmcId, symbol: coin.symbol, name: coin.name };
    stage = 'local_reads';
    const latest = await request(`${route}/${coin.id}/price`);
    const history = await request(`${route}/${coin.id}/history?limit=10`);
    const all = await request('/api/v1/prices?limit=100');
    const duplicate = await request(route, 'POST', { cmcId: 1 });
    assert.equal(latest.status, 200);
    assert.equal(history.status, 200);
    assert.equal(all.status, 200);
    assert.equal(duplicate.status, 409);
    assert.equal(latest.body.price, report.provider.priceUsd);
    assert.equal(history.body.items[0].price, latest.body.price);
    assert.equal(latest.body.stale, false);
    report.quote = latest.body;
    report.history = history.body;
    Object.assign(report.checks, { latestStatus: latest.status, historyStatus: history.status,
      allPricesStatus: all.status, duplicateStatus: duplicate.status,
      apiMatchesProviderPrice: true, historyMatchesLatest: true,
      freshAtCheck: true, additionalProviderRequestsFromReads: report.provider.requests - 1 });
    stage = 'persistence';
    repo.close(); repo = undefined;
    const reopened = new Repository(config.dbPath);
    try {
      assert.equal(reopened.latest(coin.id).price, latest.body.price);
      assert.equal(reopened.latest(coin.id).sourceUpdatedAt, latest.body.sourceUpdatedAt);
      report.checks.persistedAfterReopen = true;
    } finally { reopened.close(); }
    assert.equal(report.provider.requests, 1);
    report.success = true;
  } catch (error) {
    report.failure = { stage, code: error instanceof AppError ? error.code
      : error?.code === 'ERR_ASSERTION' ? 'CHECK_ASSERTION_FAILED' : 'CHECK_FAILED' };
    process.exitCode = 1;
  } finally {
    stop.abort();
    if (server) {
      await new Promise(done => { server.close(done); server.closeAllConnections(); });
      report.serverStopped = !server.listening;
    }
    repo?.close();
    clearTimeout(deadline);
    report.finishedAt = new Date().toISOString();
    const target = resolve(__dirname, '../docs/live-check-result.json');
    if (existsSync(target)) copyFileSync(target, target.replace('.json', `-before-${report.startedAt.replace(/[:.]/g, '-')}.json`));
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
}
main().catch(() => { console.error('Live check failed; details withheld to protect credentials.'); process.exitCode = 1; });
