import { EventEmitter } from 'events';
import * as stompit from 'stompit';
import { Logger } from '@meridian/mock-kit';

/**
 * Queue transport. Two implementations behind one interface:
 *
 *  - InProcessQueues: BEDROCK.REQ and BEDROCK.RESP are arrays in memory, exposed over the REST
 *    facade (/mq/BEDROCK.REQ etc.) so the smoke script and the adapter's `bedrock.transport=http`
 *    profile can drive the mock without a broker. Always on.
 *  - StompBridge: connects to Artemis (profile local-artemis, STOMP acceptor 61613) and mirrors
 *    the in process queues onto real destinations. Enabled by BEDROCK_STOMP_HOST.
 *
 * IBM MQ: the mock does not attach to IBM MQ directly (the MQ client needs the native libraries and
 * we are not putting those in a Node image). When the developer image is up, bedrock-adapter runs
 * against it and Bedrock messages reach this mock through the adapter's MQ->HTTP bridge. Recorded
 * in mock-external/README.md under "Why Bedrock does not sit on MQ".
 */

export const REQ_QUEUE = 'BEDROCK.REQ';
export const RESP_QUEUE = 'BEDROCK.RESP';

export interface QueuedMessage {
  id: string;
  body: string;
  headers: Record<string, string>;
  enqueuedAt: string;
}

export type Handler = (body: string, headers: Record<string, string>) => string;

export class InProcessQueues extends EventEmitter {
  private readonly queues = new Map<string, QueuedMessage[]>([[REQ_QUEUE, []], [RESP_QUEUE, []]]);
  private readonly history: QueuedMessage[] = [];
  private counter = 0;

  constructor(private readonly handler: Handler, private readonly log: Logger) {
    super();
  }

  depth(queue: string): number {
    return this.queues.get(queue)?.length ?? 0;
  }

  queueNames(): string[] {
    return [...this.queues.keys()];
  }

  recent(limit = 50): QueuedMessage[] {
    return this.history.slice(-limit);
  }

  private nextId(): string {
    this.counter += 1;
    return `MQ${Date.now().toString(36).toUpperCase()}${String(this.counter).padStart(5, '0')}`;
  }

  /** Put on BEDROCK.REQ. Bedrock "consumes" it on the next tick and replies on BEDROCK.RESP. */
  putRequest(body: string, headers: Record<string, string> = {}): QueuedMessage {
    const msg: QueuedMessage = { id: this.nextId(), body, headers, enqueuedAt: new Date().toISOString() };
    this.queues.get(REQ_QUEUE)?.push(msg);
    this.history.push({ ...msg, headers: { ...headers, queue: REQ_QUEUE } });
    setImmediate(() => this.drain());
    return msg;
  }

  private drain(): void {
    const req = this.queues.get(REQ_QUEUE);
    const resp = this.queues.get(RESP_QUEUE);
    if (!req || !resp) return;
    while (req.length > 0) {
      const msg = req.shift() as QueuedMessage;
      const started = Date.now();
      const body = this.handler(msg.body, msg.headers);
      const reply: QueuedMessage = {
        id: this.nextId(),
        body,
        headers: { correlationId: msg.headers.correlationId || msg.id, replyTo: msg.headers.replyTo || RESP_QUEUE },
        enqueuedAt: new Date().toISOString()
      };
      resp.push(reply);
      this.history.push({ ...reply, headers: { ...reply.headers, queue: RESP_QUEUE } });
      if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
      this.log.info({ event: 'bedrock.request', correlationId: reply.headers.correlationId, func: msg.body.slice(0, 8).trim(),
        rc: body.substr(44, 4), abend: body.substr(48, 4).trim() || undefined, durationMs: Date.now() - started });
      this.emit('reply', reply);
    }
  }

  /** Browse-and-get semantics: correlation match if supplied, else FIFO. */
  getResponse(correlationId?: string, waitMs = 0): Promise<QueuedMessage | undefined> {
    const take = (): QueuedMessage | undefined => {
      const resp = this.queues.get(RESP_QUEUE);
      if (!resp || resp.length === 0) return undefined;
      const idx = correlationId ? resp.findIndex((m) => m.headers.correlationId === correlationId) : 0;
      if (idx === -1) return undefined;
      return resp.splice(idx, 1)[0];
    };
    const immediate = take();
    if (immediate || waitMs <= 0) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('reply', onReply);
        resolve(take());
      }, waitMs);
      const onReply = () => {
        const found = take();
        if (found) {
          clearTimeout(timer);
          this.off('reply', onReply);
          resolve(found);
        }
      };
      this.on('reply', onReply);
    });
  }

  purge(queue: string): number {
    const q = this.queues.get(queue);
    if (!q) return 0;
    const n = q.length;
    q.length = 0;
    return n;
  }
}

export interface StompOptions {
  host: string;
  port: number;
  login: string;
  passcode: string;
}

/**
 * Mirrors the in process queues onto Artemis. Anything the adapter sends to BEDROCK.REQ over
 * STOMP/JMS is fed through the handler and the reply is sent to the JMS reply-to (or BEDROCK.RESP).
 * Reconnects with a flat 5s backoff; Artemis takes a while to come up in compose.
 */
export class StompBridge {
  private client: stompit.Client | null = null;
  private stopped = false;
  connected = false;

  constructor(private readonly options: StompOptions, private readonly queues: InProcessQueues,
              private readonly handler: Handler, private readonly log: Logger) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.client?.disconnect();
    this.client = null;
    this.connected = false;
  }

  private connect(): void {
    if (this.stopped) return;
    const connectOptions: stompit.connect.ConnectOptions = {
      host: this.options.host,
      port: this.options.port,
      connectHeaders: {
        host: '/',
        login: this.options.login,
        passcode: this.options.passcode,
        'heart-beat': '10000,10000'
      }
    };
    stompit.connect(connectOptions, (error, client) => {
      if (error) {
        this.log.warn({ event: 'bedrock.stomp.unavailable', host: this.options.host, port: this.options.port, error: error.message });
        setTimeout(() => this.connect(), 5000);
        return;
      }
      this.client = client;
      this.connected = true;
      this.log.info({ event: 'bedrock.stomp.connected', host: this.options.host, port: this.options.port, queue: REQ_QUEUE });
      client.on('error', (err) => {
        this.log.warn({ event: 'bedrock.stomp.error', error: err.message });
        this.connected = false;
        this.client = null;
        setTimeout(() => this.connect(), 5000);
      });
      client.subscribe({ destination: REQ_QUEUE, ack: 'client-individual' }, (subError, message) => {
        if (subError || !message) {
          this.log.warn({ event: 'bedrock.stomp.subscribe.error', error: subError?.message });
          return;
        }
        message.readString('utf-8', (readError, body) => {
          if (readError || body === undefined) {
            this.log.warn({ event: 'bedrock.stomp.read.error', error: readError?.message });
            client.nack(message);
            return;
          }
          // stompit's typings do not surface frame headers on Message, the runtime does
          const frameHeaders = (message as unknown as { headers: Record<string, string> }).headers || {};
          const headers: Record<string, string> = {
            correlationId: frameHeaders['correlation-id'] || frameHeaders['JMSCorrelationID'] || frameHeaders['message-id'],
            replyTo: frameHeaders['reply-to'] || frameHeaders['JMSReplyTo'] || RESP_QUEUE
          };
          const reply = this.handler(body, headers);
          // keep the in process history in step so the REST facade shows MQ traffic too
          this.queues.emit('mirror', { body, headers });
          const frame = client.send({
            destination: headers.replyTo,
            'content-type': 'text/plain',
            'correlation-id': headers.correlationId,
            persistent: 'false'
          });
          frame.write(reply);
          frame.end();
          client.ack(message);
          this.log.info({ event: 'bedrock.request', transport: 'stomp', correlationId: headers.correlationId,
            func: body.slice(0, 8).trim(), rc: reply.substr(44, 4), abend: reply.substr(48, 4).trim() || undefined });
        });
      });
    });
  }
}
