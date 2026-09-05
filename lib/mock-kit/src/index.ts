/**
 * Shared plumbing for the mocks. Kept deliberately small: express app with JSON request logging
 * in the same field shape common-starter emits (event, severity, correlationId, service), a
 * health endpoint, the shared fixture set, and best effort forwarding of log lines to
 * splunk-hec-mock so a request can be traced across mocks in the demo.
 *
 * Not a bank artefact in the real estate; in Meridian these mocks live in the platform
 * engineering "sandbox-mocks" repository and this is its `common` module.
 */

import express, { Express, NextFunction, Request, Response } from 'express';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { FixtureSet, generateFixtures } from '@meridian/domain-fixtures';

export { express, Request, Response, NextFunction };

export const CORRELATION_HEADER = 'x-correlation-id';

/** Seed shared by every mock and BFF so that a customer id means the same thing everywhere. */
export const ESTATE_SEED = process.env.MERIDIAN_FIXTURE_SEED || 'meridian';

let cached: FixtureSet | undefined;

export function fixtures(): FixtureSet {
  if (!cached) {
    cached = generateFixtures({ seed: ESTATE_SEED, customers: 25 });
  }
  return cached;
}

export interface LogFields {
  event: string;
  severity?: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  correlationId?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const HEC_URL = process.env.SPLUNK_HEC_URL || '';
const HEC_TOKEN = process.env.SPLUNK_HEC_TOKEN || 'CHANGEME-hec-token-mocks';

function forwardToHec(service: string, line: Record<string, unknown>): void {
  // The collector must not ship its own access log to itself: every forwarded event is a
  // request, which is another event (PLAT-2721).
  if (!HEC_URL || service === 'splunk-hec-mock') {
    return;
  }
  try {
    const url = new URL(HEC_URL);
    const body = JSON.stringify({
      time: Date.now() / 1000,
      host: service,
      source: `mock-external/${service}`,
      sourcetype: 'meridian:json',
      event: line
    });
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname || '/services/collector/event',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Splunk ${HEC_TOKEN}`,
        'content-length': Buffer.byteLength(body)
      },
      timeout: 500
    });
    req.on('error', () => undefined);
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch {
    // never let telemetry take the mock down
  }
}

export function createLogger(service: string): Logger {
  const emit = (severity: LogFields['severity'], fields: LogFields) => {
    const line = { ts: new Date().toISOString(), service, severity, ...fields };
    if (process.env.MOCK_LOG_SILENT !== '1' && !process.env.JEST_WORKER_ID) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(line));
    }
    forwardToHec(service, line);
  };
  return {
    info: (f) => emit('INFO', f),
    warn: (f) => emit('WARN', f),
    error: (f) => emit('ERROR', f)
  };
}

export interface MockApp {
  app: Express;
  log: Logger;
  service: string;
  listen(port: number): Promise<http.Server>;
}

export function correlationId(req: Request): string {
  const existing = req.header(CORRELATION_HEADER);
  return existing && existing.length > 0 ? existing : randomUUID();
}

export interface MockAppOptions {
  /** path prefixes whose bodies are delivered as raw text regardless of content type */
  rawTextPaths?: string[];
}

export function createMockApp(service: string, options: MockAppOptions = {}): MockApp {
  const app = express();
  const log = createLogger(service);

  app.disable('x-powered-by');
  for (const prefix of options.rawTextPaths || []) {
    app.use(prefix, express.text({ type: () => true, limit: '5mb' }));
  }
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.text({ type: ['text/plain', 'application/octet-stream'], limit: '2mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const cid = correlationId(req);
    res.locals.correlationId = cid;
    res.setHeader(CORRELATION_HEADER, cid);
    // CORS for the Angular dev servers on 4200-4205. Wide open on purpose, this is a mock.
    res.setHeader('access-control-allow-origin', req.header('origin') || '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-headers',
      'authorization, content-type, x-correlation-id, x-meridian-xsrf, x-lantern-session, x-idempotency-key, x-vault-token');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-correlation-id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') {
        return;
      }
      log.info({
        event: 'http.request',
        correlationId: cid,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started
      });
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'UP', service, seed: ESTATE_SEED });
  });

  return {
    app,
    log,
    service,
    listen(port: number) {
      return new Promise((resolve, reject) => {
        // no host: node binds dual-stack (::) where IPv6 exists, 0.0.0.0 otherwise. Node 18's
        // fetch resolves "localhost" to ::1 first, so an IPv4-only bind breaks the smoke harness.
        const server = app.listen(port, () => {
          log.info({ event: 'service.started', port });
          resolve(server);
        });
        server.on('error', reject);
      });
    }
  };
}

/** Standard error envelope, same shape as common-starter's ErrorResponse. */
export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({
    code,
    message,
    correlationId: res.locals.correlationId,
    timestamp: new Date().toISOString()
  });
}

export function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Deterministic 32 bit hash. Used wherever a mock needs a stable pseudo random value per id. */
export function stableHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Fire-and-forget webhook POST. Vendors retry three times with backoff; we do one attempt and
 * log the outcome, which is all the demo needs. Returns the delivery record for the debug endpoints.
 */
export interface WebhookDelivery {
  url: string;
  event: string;
  status: number | null;
  error?: string;
  sentAt: string;
}

export function deliverWebhook(log: Logger, url: string, event: string, payload: unknown, headers: Record<string, string> = {}): Promise<WebhookDelivery> {
  const body = JSON.stringify(payload);
  const record: WebhookDelivery = { url, event, status: null, sentAt: new Date().toISOString() };
  return new Promise((resolve) => {
    try {
      const target = new URL(url);
      const req = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-webhook-event': event, ...headers },
        timeout: 3000
      }, (res) => {
        record.status = res.statusCode || 0;
        res.resume();
        res.on('end', () => {
          log.info({ event: 'webhook.delivered', url, webhookEvent: event, status: record.status });
          resolve(record);
        });
      });
      req.on('error', (err) => {
        record.error = err.message;
        log.warn({ event: 'webhook.failed', url, webhookEvent: event, error: err.message });
        resolve(record);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end(body);
    } catch (err) {
      record.error = (err as Error).message;
      resolve(record);
    }
  });
}
