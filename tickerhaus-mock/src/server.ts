import { createMockApp, MockApp, sendError, stableHash } from '@meridian/mock-kit';

/**
 * TickerHaus market data. Consumed by ledgerline-web (FX on wires) and by the Meridian Online
 * markets tile. Rates are a deterministic random walk seeded from the pair so two developers
 * looking at the same second see the same number, which turned out to matter for screenshots
 * in defect reports (MOL-4471).
 *
 * /v1/quotes/slow exists because the real vendor's index endpoint takes 2 to 6 seconds at the
 * open and the front end has to cope. Do not "fix" it.
 */

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCAD', 'USDMXN', 'AUDUSD', 'USDCHF', 'USDCNH'];
const BASE_RATES: Record<string, number> = {
  EURUSD: 1.0842, GBPUSD: 1.2710, USDJPY: 149.32, USDCAD: 1.3565, USDMXN: 17.08, AUDUSD: 0.6551, USDCHF: 0.8812, USDCNH: 7.2140
};

// Fictional indices. The names are Meridian-internal composites, not exchange products.
const INDICES: Record<string, { name: string; base: number }> = {
  'MTB:US100': { name: 'Meridian US Large Cap Composite', base: 4821.35 },
  'MTB:USMID': { name: 'Meridian US Mid Cap Composite', base: 2743.10 },
  'MTB:GLOBAL': { name: 'Meridian Global Blend', base: 1187.62 },
  'MTB:RATES10': { name: 'Meridian 10Y Benchmark Yield', base: 4.27 },
  'MTB:CRED': { name: 'Meridian IG Credit Spread', base: 98.4 }
};

function walk(symbol: string, base: number, tSeconds: number, volatility: number): number {
  // sum of a few seeded sinusoids: smooth, deterministic, looks like a chart
  const h = stableHash(symbol);
  const a = ((h & 0xff) / 255) * Math.PI * 2;
  const b = (((h >> 8) & 0xff) / 255) * Math.PI * 2;
  const c = (((h >> 16) & 0xff) / 255) * Math.PI * 2;
  const drift = Math.sin(tSeconds / 900 + a) * 0.6 + Math.sin(tSeconds / 137 + b) * 0.3 + Math.sin(tSeconds / 11 + c) * 0.1;
  return base * (1 + drift * volatility);
}

function fxQuote(pair: string, at = Date.now()) {
  const mid = walk(pair, BASE_RATES[pair], at / 1000, 0.004);
  const decimals = pair.endsWith('JPY') ? 3 : 5;
  const spread = mid * 0.0002;
  return {
    pair, base: pair.slice(0, 3), quote: pair.slice(3),
    bid: Number((mid - spread / 2).toFixed(decimals)),
    ask: Number((mid + spread / 2).toFixed(decimals)),
    mid: Number(mid.toFixed(decimals)),
    timestamp: new Date(at).toISOString(),
    source: 'TICKERHAUS-SIM'
  };
}

function indexQuote(symbol: string, at = Date.now()) {
  const def = INDICES[symbol];
  const last = walk(symbol, def.base, at / 1000, 0.012);
  const open = walk(symbol, def.base, Math.floor(at / 86_400_000) * 86_400, 0.012);
  return {
    symbol, name: def.name,
    last: Number(last.toFixed(2)), open: Number(open.toFixed(2)),
    change: Number((last - open).toFixed(2)), changePercent: Number((((last - open) / open) * 100).toFixed(3)),
    timestamp: new Date(at).toISOString()
  };
}

export function buildServer(): MockApp {
  const mock = createMockApp('tickerhaus-mock');
  const { app, log } = mock;

  app.get('/v1/fx/pairs', (_req, res) => res.json({ pairs: PAIRS }));

  app.get('/v1/fx/rates', (req, res) => {
    const wanted = typeof req.query.pairs === 'string' ? req.query.pairs.split(',').map((p) => p.toUpperCase()) : PAIRS;
    const unknown = wanted.filter((p) => !BASE_RATES[p]);
    if (unknown.length > 0) {
      sendError(res, 400, 'UNKNOWN_PAIR', `unsupported pair(s): ${unknown.join(',')}`);
      return;
    }
    res.json({ rates: wanted.map((p) => fxQuote(p)), asOf: new Date().toISOString() });
  });

  app.get('/v1/fx/rates/:pair', (req, res) => {
    const pair = req.params.pair.toUpperCase();
    if (!BASE_RATES[pair]) {
      sendError(res, 404, 'UNKNOWN_PAIR', `unsupported pair ${pair}`);
      return;
    }
    res.json(fxQuote(pair));
  });

  app.post('/v1/fx/convert', (req, res) => {
    const { from, to, amount } = req.body as { from?: string; to?: string; amount?: number };
    if (!from || !to || typeof amount !== 'number') {
      sendError(res, 400, 'BAD_REQUEST', 'from, to and numeric amount are required');
      return;
    }
    const direct = `${from}${to}`.toUpperCase();
    const inverse = `${to}${from}`.toUpperCase();
    let rate: number;
    if (from.toUpperCase() === to.toUpperCase()) rate = 1;
    else if (BASE_RATES[direct]) rate = fxQuote(direct).ask;
    else if (BASE_RATES[inverse]) rate = 1 / fxQuote(inverse).bid;
    else {
      sendError(res, 400, 'UNKNOWN_PAIR', `no rate for ${from}/${to}`);
      return;
    }
    res.json({ from: from.toUpperCase(), to: to.toUpperCase(), amount, rate: Number(rate.toFixed(6)), converted: Number((amount * rate).toFixed(2)), asOf: new Date().toISOString() });
  });

  app.get('/v1/indices', (_req, res) => res.json({ indices: Object.keys(INDICES).map((s) => indexQuote(s)) }));

  app.get('/v1/indices/:symbol', (req, res) => {
    const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
    if (!INDICES[symbol]) {
      sendError(res, 404, 'UNKNOWN_SYMBOL', `no index ${symbol}`);
      return;
    }
    res.json(indexQuote(symbol));
  });

  app.get('/v1/indices/:symbol/history', (req, res) => {
    const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
    if (!INDICES[symbol]) {
      sendError(res, 404, 'UNKNOWN_SYMBOL', `no index ${symbol}`);
      return;
    }
    const points = Math.min(Number(req.query.points || 60), 500);
    const stepMs = Number(req.query.stepSeconds || 60) * 1000;
    const now = Date.now();
    res.json({ symbol, points: Array.from({ length: points }, (_, i) => indexQuote(symbol, now - (points - 1 - i) * stepMs)) });
  });

  // Deliberately slow. Real TickerHaus index endpoint at the open. 2-6 seconds, or ?delayMs=.
  app.get('/v1/quotes/slow', (req, res) => {
    const delayMs = req.query.delayMs ? Math.min(Number(req.query.delayMs), 30_000) : 2000 + (stableHash(String(Date.now())) % 4000);
    log.info({ event: 'tickerhaus.slow', delayMs, correlationId: res.locals.correlationId });
    setTimeout(() => {
      res.json({ delayMs, indices: Object.keys(INDICES).map((s) => indexQuote(s)), rates: PAIRS.map((p) => fxQuote(p)) });
    }, delayMs);
  });

  // SSE stream. ?pairs=EURUSD,GBPUSD&symbols=MTB:US100&intervalMs=1000
  app.get('/v1/stream', (req, res) => {
    const pairs = typeof req.query.pairs === 'string' ? req.query.pairs.split(',').map((p) => p.toUpperCase()).filter((p) => BASE_RATES[p]) : PAIRS.slice(0, 3);
    const symbols = typeof req.query.symbols === 'string' ? req.query.symbols.split(',').map((s) => s.toUpperCase()).filter((s) => INDICES[s]) : ['MTB:US100'];
    const intervalMs = Math.max(250, Math.min(Number(req.query.intervalMs || 1000), 10_000));
    res.status(200).set({
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no'
    });
    res.flushHeaders();
    let id = 0;
    const send = (event: string, data: unknown) => {
      id += 1;
      res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('hello', { pairs, symbols, intervalMs });
    const timer = setInterval(() => {
      for (const p of pairs) send('fx', fxQuote(p));
      for (const s of symbols) send('index', indexQuote(s));
    }, intervalMs);
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });

  return mock;
}
