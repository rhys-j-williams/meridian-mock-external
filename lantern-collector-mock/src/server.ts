import * as fs from 'fs';
import * as path from 'path';
import { createMockApp, MockApp, sendError } from '@meridian/mock-kit';

/**
 * Lumenview Lantern collector. Ingests /v1/batch (what lantern.js sends) and the single-event
 * /v1/track /v1/page /v1/identify routes (what @meridian/lantern-sdk's HttpClient transport
 * sends when the vendor script is blocked by CSP, which is most of UAT). Keeps the last 50k
 * events in memory, exposes /v1/summary and /v1/events for the demo, and serves lantern.min.js
 * so the "Meridian hosted copy" in the SDK README is a real URL.
 *
 * Write keys are not validated beyond "present": the vendor sandbox does not validate them
 * either, which is how LNTN-388 happened (six months of UAT traffic in the prod project).
 */

export interface LanternEvent {
  type: 'track' | 'page' | 'identify' | 'group' | 'screen';
  messageId: string;
  timestamp: string;
  receivedAt: string;
  writeKey: string | null;
  sessionId: string | null;
  anonymousId: string | null;
  userId: string | null;
  event?: string;
  name?: string;
  properties?: Record<string, unknown>;
  traits?: Record<string, unknown>;
  context?: Record<string, unknown>;
  source: 'lantern.js' | 'lantern-sdk' | 'server' | 'unknown';
}

const MAX_EVENTS = 50_000;

export function buildServer(options: { staticDir: string }): MockApp & { events: LanternEvent[] } {
  const mock = createMockApp('lantern-collector-mock');
  const { app, log } = mock;
  const events: LanternEvent[] = [];
  let seq = 0;

  const scriptPath = path.join(options.staticDir, 'lantern.js');
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '/* lantern.js missing from static dir */';

  const sourceOf = (req: import('express').Request, ev: Record<string, unknown>): LanternEvent['source'] => {
    const lib = (ev.context as { library?: { name?: string } } | undefined)?.library?.name;
    if (lib === 'lantern.js') return 'lantern.js';
    if (lib === '@meridian/lantern-sdk' || req.header('x-lantern-sdk')) return 'lantern-sdk';
    if (req.header('x-lantern-server')) return 'server';
    return 'unknown';
  };

  const ingest = (req: import('express').Request, raw: Record<string, unknown>, type?: LanternEvent['type']): LanternEvent | null => {
    const t = (type || raw.type) as LanternEvent['type'] | undefined;
    if (!t || !['track', 'page', 'identify', 'group', 'screen'].includes(t)) return null;
    if (t === 'track' && typeof raw.event !== 'string') return null;
    seq += 1;
    const ev: LanternEvent = {
      type: t,
      messageId: typeof raw.messageId === 'string' ? raw.messageId : `srv-${Date.now()}-${seq}`,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      writeKey: (raw.writeKey as string) || req.header('x-lantern-write-key') || null,
      sessionId: (raw.sessionId as string) || req.header('x-lantern-session') || null,
      anonymousId: (raw.anonymousId as string) || null,
      userId: (raw.userId as string) || null,
      event: raw.event as string | undefined,
      name: raw.name as string | undefined,
      properties: raw.properties as Record<string, unknown> | undefined,
      traits: raw.traits as Record<string, unknown> | undefined,
      context: raw.context as Record<string, unknown> | undefined,
      source: sourceOf(req, raw)
    };
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    return ev;
  };

  const requireWriteKey = (req: import('express').Request, res: import('express').Response): boolean => {
    const key = req.header('x-lantern-write-key') || (req.body as { writeKey?: string })?.writeKey
      || req.header('authorization')?.replace(/^Basic /i, '');
    if (!key) {
      sendError(res, 401, 'WRITE_KEY_REQUIRED', 'X-Lantern-Write-Key header or writeKey body field required');
      return false;
    }
    return true;
  };

  const serveScript = (_req: import('express').Request, res: import('express').Response) => {
    res.type('application/javascript').set('cache-control', 'public, max-age=300').send(script);
  };
  app.get('/lantern.min.js', serveScript);
  app.get('/lantern.js', serveScript);
  app.get('/v4/lantern.min.js', serveScript);

  app.post('/v1/batch', (req, res) => {
    if (!requireWriteKey(req, res)) return;
    const body = req.body as { batch?: Record<string, unknown>[] };
    if (!Array.isArray(body.batch)) {
      sendError(res, 400, 'BAD_BATCH', 'body.batch must be an array');
      return;
    }
    const accepted = body.batch.map((e) => ingest(req, e)).filter((e): e is LanternEvent => e !== null);
    log.info({ event: 'lantern.batch', accepted: accepted.length, rejected: body.batch.length - accepted.length, correlationId: res.locals.correlationId });
    res.json({ success: true, accepted: accepted.length, rejected: body.batch.length - accepted.length });
  });

  for (const type of ['track', 'page', 'identify', 'group', 'screen'] as const) {
    app.post(`/v1/${type}`, (req, res) => {
      if (!requireWriteKey(req, res)) return;
      const ev = ingest(req, req.body as Record<string, unknown>, type);
      if (!ev) {
        sendError(res, 400, 'BAD_EVENT', `invalid ${type} payload`);
        return;
      }
      res.json({ success: true, messageId: ev.messageId });
    });
  }

  app.get('/v1/events', (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const event = typeof req.query.event === 'string' ? req.query.event : undefined;
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const limit = Math.min(Number(req.query.limit || 100), 5000);
    const hits = events.filter((e) => (!type || e.type === type) && (!userId || e.userId === userId)
      && (!sessionId || e.sessionId === sessionId) && (!event || e.event === event || e.name === event) && (!since || e.receivedAt >= since));
    res.json({ count: hits.length, events: hits.slice(-limit) });
  });

  app.get('/v1/summary', (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const pool = since ? events.filter((e) => e.receivedAt >= since) : events;
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const topEvents: Record<string, number> = {};
    const topPages: Record<string, number> = {};
    const sessions = new Set<string>();
    const users = new Set<string>();
    for (const e of pool) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      bySource[e.source] = (bySource[e.source] || 0) + 1;
      if (e.sessionId) sessions.add(e.sessionId);
      if (e.userId) users.add(e.userId);
      if (e.type === 'track' && e.event) topEvents[e.event] = (topEvents[e.event] || 0) + 1;
      if (e.type === 'page') {
        const p = (e.properties?.path as string) || e.name || '(unknown)';
        topPages[p] = (topPages[p] || 0) + 1;
      }
    }
    const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => ({ name: k, count: v }));
    res.json({
      total: pool.length, sessions: sessions.size, identifiedUsers: users.size, byType, bySource,
      topEvents: top(topEvents), topPages: top(topPages),
      first: pool[0]?.receivedAt || null, last: pool[pool.length - 1]?.receivedAt || null
    });
  });

  app.delete('/v1/events', (_req, res) => {
    const n = events.length;
    events.length = 0;
    res.json({ cleared: n });
  });

  return { ...mock, events };
}
