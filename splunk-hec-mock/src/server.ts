import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createMockApp, MockApp } from '@meridian/mock-kit';

/**
 * Splunk HTTP Event Collector. Accepts /services/collector/event (single JSON or newline
 * concatenated JSON, as the Splunk logback appender and the Nest pino transport both send),
 * validates the `Splunk <token>` header, appends NDJSON to a daily file under the data
 * directory, and offers /search?correlationId=... which the demo uses to show one request
 * threading bff-retail -> bedrock-adapter -> bedrock.
 *
 * Accepted tokens: HEC_TOKENS env (comma separated) or the two placeholders every service
 * configuration already carries. Splunk returns 403 "Invalid token" (code 4) for anything else.
 */

interface HecEvent {
  time?: number;
  host?: string;
  source?: string;
  sourcetype?: string;
  index?: string;
  event: unknown;
  fields?: Record<string, unknown>;
}

interface Stored extends HecEvent {
  receivedAt: string;
  correlationId: string | null;
  service: string | null;
  level: string | null;
  seq: number;
}

function extract(obj: unknown, keys: string[]): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const nested of ['fields', 'context', 'mdc', 'meta']) {
    const inner = rec[nested];
    if (inner && typeof inner === 'object') {
      const found = extract(inner, keys);
      if (found) return found;
    }
  }
  return null;
}

export function buildServer(options: { dataDir: string; tokens: string[] }): MockApp & { flush(): void } {
  const mock = createMockApp('splunk-hec-mock', { rawTextPaths: ['/services/collector'] });
  const { app, log } = mock;
  fs.mkdirSync(options.dataDir, { recursive: true });
  const tokens = new Set(options.tokens);
  const recent: Stored[] = [];
  let seq = 0;
  let received = 0;
  let rejected = 0;

  const fileFor = (d = new Date()) => path.join(options.dataDir, `hec-${d.toISOString().slice(0, 10)}.ndjson`);

  const checkToken = (req: import('express').Request, res: import('express').Response): boolean => {
    const header = req.header('authorization') || '';
    const m = /^Splunk\s+(.+)$/i.exec(header.trim());
    if (!m || !tokens.has(m[1].trim())) {
      rejected += 1;
      log.warn({ event: 'hec.token.rejected', remote: req.ip });
      res.status(403).json({ text: 'Invalid token', code: 4 });
      return false;
    }
    return true;
  };

  const store = (e: HecEvent): Stored => {
    seq += 1;
    const ev = typeof e.event === 'string' ? tryJson(e.event) : e.event;
    const stored: Stored = {
      ...e, event: ev, receivedAt: new Date().toISOString(), seq,
      correlationId: extract(ev, ['correlationId', 'correlation_id', 'x-correlation-id', 'traceId', 'trace_id']) || extract(e.fields, ['correlationId']),
      // common-starter and the BFFs put service on the envelope (SplunkHecLayout), the mocks put it
      // in the event body, raw HEC clients use fields.service.
      service: extract(ev, ['service', 'app', 'application', 'serviceName'])
        || extract(e, ['service']) || extract(e.fields, ['service']) || e.host || e.source || null,
      level: extract(ev, ['severity', 'level', 'logLevel'])
    };
    fs.appendFileSync(fileFor(), JSON.stringify(stored) + '\n');
    recent.push(stored);
    if (recent.length > 20_000) recent.splice(0, recent.length - 20_000);
    return stored;
  };

  const parseBody = (raw: unknown): HecEvent[] => {
    if (typeof raw === 'string') {
      // Splunk allows concatenated JSON objects with or without newlines
      const out: HecEvent[] = [];
      let depth = 0;
      let start = -1;
      let inString = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (inString) {
          if (ch === '\\') i++;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            out.push(JSON.parse(raw.slice(start, i + 1)));
            start = -1;
          }
        }
      }
      return out;
    }
    if (Array.isArray(raw)) return raw as HecEvent[];
    if (raw && typeof raw === 'object') return [raw as HecEvent];
    return [];
  };

  const collector = (req: import('express').Request, res: import('express').Response) => {
    if (!checkToken(req, res)) return;
    let events: HecEvent[];
    try {
      events = parseBody(req.body);
    } catch {
      res.status(400).json({ text: 'Invalid data format', code: 6 });
      return;
    }
    if (events.length === 0 || events.some((e) => e.event === undefined)) {
      res.status(400).json({ text: 'No data', code: 5 });
      return;
    }
    for (const e of events) store(e);
    received += events.length;
    res.json({ text: 'Success', code: 0, ackId: seq });
  };

  app.post('/services/collector/event', collector);
  app.post('/services/collector/event/1.0', collector);
  app.post('/services/collector', collector);
  app.post('/services/collector/raw', (req, res) => {
    if (!checkToken(req, res)) return;
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    for (const line of text.split(/\r?\n/).filter((l) => l.trim().length > 0)) {
      store({ event: tryJson(line), sourcetype: String(req.query.sourcetype || 'raw'), host: String(req.query.host || 'unknown') });
      received += 1;
    }
    res.json({ text: 'Success', code: 0 });
  });
  app.get('/services/collector/health', (_req, res) => res.json({ text: 'HEC is healthy', code: 17 }));
  app.get('/services/collector/health/1.0', (_req, res) => res.json({ text: 'HEC is healthy', code: 17 }));

  // Search. Not SPL. correlationId=, service=, level=, q= (substring), since= (ISO), limit=
  app.get('/search', async (req, res) => {
    const correlationId = typeof req.query.correlationId === 'string' ? req.query.correlationId : undefined;
    const service = typeof req.query.service === 'string' ? req.query.service : undefined;
    const level = typeof req.query.level === 'string' ? req.query.level.toUpperCase() : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase() : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limit = Math.min(Number(req.query.limit || 200), 5000);
    const matches = (e: Stored) => (!correlationId || e.correlationId === correlationId)
      && (!service || e.service === service)
      && (!level || (e.level || '').toUpperCase() === level)
      && (!since || e.receivedAt >= since)
      && (!q || JSON.stringify(e.event).toLowerCase().includes(q));

    let pool: Stored[] = recent;
    if (req.query.scan === 'disk' || correlationId) {
      // correlation searches read the files so a restart does not lose the trace
      pool = await readAll(options.dataDir);
    }
    const hits = pool.filter(matches);
    res.json({
      query: { correlationId, service, level, q, since },
      count: hits.length,
      services: [...new Set(hits.map((h) => h.service).filter(Boolean))].sort(),
      results: hits.slice(-limit)
    });
  });

  app.get('/debug/stats', (_req, res) => {
    const files = fs.readdirSync(options.dataDir).filter((f) => f.endsWith('.ndjson')).sort();
    res.json({ received, rejected, inMemory: recent.length, files, dataDir: options.dataDir });
  });

  return { ...mock, flush: () => undefined };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readAll(dir: string): Promise<Stored[]> {
  const out: Stored[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort()) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, f)) });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // half written line at the end of a file; skip it
      }
    }
  }
  return out;
}
