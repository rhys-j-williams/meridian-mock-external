import * as fs from 'fs';
import * as path from 'path';
import { createMockApp, fixtures, MockApp, sendError } from '@meridian/mock-kit';
import { Ledger, RC_ABEND } from './ledger';
import {
  decodeAccountRecord,
  decodeRequest,
  decodeResponse,
  decodeTransactionRecord,
  encodeRequest,
  encodeResponse,
  RecordFormatError
} from './messages';
import { InProcessQueues, REQ_QUEUE, RESP_QUEUE, StompBridge } from './transport';

export interface BedrockOptions {
  /** directory the end of day report files are written to */
  batchDir: string;
  /** minutes between simulated end of day cycles; 0 disables the timer */
  batchIntervalMinutes: number;
  stomp?: { host: string; port: number; login: string; passcode: string };
}

export interface BedrockMock extends MockApp {
  ledger: Ledger;
  queues: InProcessQueues;
  runBatch(): { cycle: string; file: string };
  shutdown(): void;
}

export function buildServer(options: BedrockOptions): BedrockMock {
  const mock = createMockApp('bedrock-core-mock');
  const { app, log } = mock;
  const ledger = new Ledger(fixtures());

  const handler = (body: string, headers: Record<string, string>): string => {
    let func = body.slice(0, 8).trim();
    const corr = headers.correlationId || body.substr(8, 36).trim();
    try {
      const req = decodeRequest(body);
      func = req.func;
      return encodeResponse(ledger.handle(req));
    } catch (err) {
      if (err instanceof RecordFormatError) {
        log.warn({ event: 'bedrock.abend', abend: 'ASRA', field: err.field, correlationId: corr, detail: err.message });
        return encodeResponse(ledger.abend(corr, func));
      }
      throw err;
    }
  };

  const queues = new InProcessQueues(handler, log);
  let bridge: StompBridge | undefined;
  if (options.stomp) {
    bridge = new StompBridge(options.stomp, queues, handler, log);
    bridge.start();
  }

  fs.mkdirSync(options.batchDir, { recursive: true });

  const runBatch = () => {
    const result = ledger.runEndOfDay();
    const file = path.join(options.batchDir, `MTBD900E.${result.cycle}.rpt`);
    fs.writeFileSync(file, result.lines.join('\n') + '\n', 'utf8');
    log.info({ event: 'bedrock.batch.complete', cycle: result.cycle, interestPostings: result.interestPostings, settled: result.settled, file });
    return { cycle: result.cycle, file };
  };

  let timer: NodeJS.Timeout | undefined;
  if (options.batchIntervalMinutes > 0) {
    timer = setInterval(runBatch, options.batchIntervalMinutes * 60_000);
    timer.unref();
  }

  // ---- queue facade -------------------------------------------------------------------------

  app.get('/mq/queues', (_req, res) => {
    res.json({
      transport: bridge ? (bridge.connected ? 'stomp+inproc' : 'inproc (stomp reconnecting)') : 'inproc',
      queues: queues.queueNames().map((name) => ({ name, depth: queues.depth(name) }))
    });
  });

  // PUT a raw fixed width message, exactly what the adapter would put on MQ. text/plain body.
  app.post(`/mq/${REQ_QUEUE}`, (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (body.length === 0) {
      sendError(res, 400, 'EMPTY_MESSAGE', 'expected a fixed width MTBREQ body as text/plain');
      return;
    }
    const correlationId = req.header('x-correlation-id') || body.substr(8, 36).trim() || undefined;
    const msg = queues.putRequest(body.replace(/\r?\n$/, ''), correlationId ? { correlationId } : {});
    res.status(202).json({ messageId: msg.id, queue: REQ_QUEUE, correlationId: correlationId || msg.id });
  });

  app.get(`/mq/${RESP_QUEUE}`, async (req, res) => {
    const correlationId = typeof req.query.correlationId === 'string' ? req.query.correlationId : undefined;
    const wait = Math.min(Number(req.query.wait || 0), 10_000);
    const msg = await queues.getResponse(correlationId, wait);
    if (!msg) {
      res.status(204).end();
      return;
    }
    res.type('text/plain').set('x-message-id', msg.id).set('x-correlation-id', msg.headers.correlationId).send(msg.body);
  });

  app.get('/mq/history', (req, res) => {
    res.json(queues.recent(Number(req.query.limit || 50)));
  });

  app.delete('/mq/:queue', (req, res) => {
    res.json({ queue: req.params.queue, purged: queues.purge(req.params.queue) });
  });

  // Convenience: JSON in, request encoded, handled, reply decoded. Used by the smoke script and
  // by people who cannot count to 200 by hand.
  app.post('/debug/request', (req, res) => {
    const input = req.body as Record<string, unknown>;
    if (!input || typeof input.func !== 'string') {
      sendError(res, 400, 'BAD_REQUEST', 'body must be JSON with at least a func');
      return;
    }
    const wire = encodeRequest({
      func: input.func,
      correlationId: (input.correlationId as string) || res.locals.correlationId,
      accountId: input.accountId as string,
      customerId: input.customerId as string,
      amountMinor: typeof input.amountMinor === 'number' ? input.amountMinor : null,
      transactionId: input.transactionId as string,
      mcc: input.mcc as string,
      channel: input.channel as string,
      description: input.description as string
    });
    const reply = handler(wire, { correlationId: (input.correlationId as string) || res.locals.correlationId });
    const recordLength = input.func === 'TRANPOST' || input.func === 'TRANLIST' ? 160 : 136;
    const decoded = decodeResponse(reply, recordLength);
    res.json({
      request: wire,
      response: reply,
      decoded: {
        ...decoded,
        records: decoded.records.map((r) => (recordLength === 160 ? decodeTransactionRecord(r) : decodeAccountRecord(r)))
      }
    });
  });

  // ---- ledger facade ------------------------------------------------------------------------

  app.get('/debug/accounts', (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const list = customerId ? ledger.accountsForCustomer(customerId) : ledger.allAccounts();
    res.json(list.map((a) => ({
      accountId: a.accountId, customerId: a.customerId, type: a.type, status: a.status,
      currentBalanceMinor: a.currentBalanceMinor, availableBalanceMinor: a.availableBalanceMinor,
      accountNumberLastFour: a.accountNumber.slice(-4), routingNumber: a.routingNumber
    })));
  });

  app.get('/debug/accounts/:accountId', (req, res) => {
    const account = ledger.account(req.params.accountId);
    if (!account) {
      sendError(res, 404, 'ACCOUNT_NOT_FOUND', `no account ${req.params.accountId}`);
      return;
    }
    const { accountNumber, ...safe } = account;
    res.json({ ...safe, accountNumberLastFour: accountNumber.slice(-4), postings: ledger.postingsFor(account.accountId).length });
  });

  app.get('/debug/accounts/:accountId/postings', (req, res) => {
    if (!ledger.account(req.params.accountId)) {
      sendError(res, 404, 'ACCOUNT_NOT_FOUND', `no account ${req.params.accountId}`);
      return;
    }
    res.json(ledger.postingsFor(req.params.accountId).slice(-Number(req.query.limit || 100)).reverse());
  });

  app.get('/debug/stats', (_req, res) => {
    res.json({ ...ledger.stats(), batchDir: options.batchDir, stomp: bridge ? bridge.connected : null });
  });

  app.post('/debug/batch/run', (_req, res) => {
    res.json(runBatch());
  });

  app.get('/debug/batch/reports', (_req, res) => {
    const files = fs.readdirSync(options.batchDir).filter((f) => f.startsWith('MTBD900E.')).sort();
    res.json(files.map((f) => ({ file: f, bytes: fs.statSync(path.join(options.batchDir, f)).size })));
  });

  app.get('/debug/batch/reports/:file', (req, res) => {
    const target = path.join(options.batchDir, path.basename(req.params.file));
    if (!fs.existsSync(target)) {
      sendError(res, 404, 'REPORT_NOT_FOUND', 'no such batch report');
      return;
    }
    res.type('text/plain').send(fs.readFileSync(target, 'utf8'));
  });

  app.get('/debug/abend-codes', (_req, res) => {
    res.json({
      ASRA: 'Data exception decoding a zoned decimal field (S0C7). RC 0012.',
      AEY9: 'Unsupported REQ-FUNC. RC 0012.',
      returnCodes: { '0000': 'ok', '0004': 'warning / partial / duplicate', '0008': 'business rejection', [String(RC_ABEND).padStart(4, '0')]: 'abend' }
    });
  });

  return {
    ...mock,
    ledger,
    queues,
    runBatch,
    shutdown() {
      if (timer) clearInterval(timer);
      bridge?.stop();
    }
  };
}
