import { randomUUID } from 'crypto';
import { createMockApp, deliverWebhook, fixtures, MockApp, sendError, stableHash, WebhookDelivery } from '@meridian/mock-kit';

/**
 * PayLink person to person network. Directory is every fixture customer (email + mobile
 * tokens), so any fixture customer can pay any other. Idempotency keys are honoured for 24h
 * in the real network and forever here. Settlement is simulated: a payment settles a few
 * seconds after it is sent and the network posts a settlement webhook to the URL supplied
 * on the send (or PAYLINK_DEFAULT_WEBHOOK, which estate-up points at bff-retail).
 *
 * The request-money feature is behind the semaphore flag paylink_request_money on the app
 * side; the network mock always supports it.
 */

interface Contact {
  token: string;
  customerId: string;
  displayName: string;
  emailMasked: string;
  mobileMasked: string;
  enrolledAt: string;
  network: 'paylink';
}

type PaymentStatus = 'PENDING' | 'SETTLED' | 'FAILED' | 'RETURNED';

interface Payment {
  paymentId: string;
  idempotencyKey: string;
  senderCustomerId: string;
  recipientToken: string;
  amountMinor: number;
  currency: 'USD';
  memo: string;
  status: PaymentStatus;
  createdAt: string;
  settledAt: string | null;
  failureReason?: string;
  webhook?: string;
}

interface MoneyRequest {
  requestId: string;
  requesterCustomerId: string;
  payerToken: string;
  amountMinor: number;
  memo: string;
  status: 'OPEN' | 'PAID' | 'DECLINED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  paymentId?: string;
}

const mask = (v: string, keep: number) => v.slice(0, 1) + '***' + v.slice(-keep);

export function buildServer(options: { settleAfterMs: number } = { settleAfterMs: 3000 }): MockApp {
  const mock = createMockApp('paylink-network-mock');
  const { app, log } = mock;
  const fx = fixtures();

  const contacts: Contact[] = fx.customers.map((c) => ({
    token: `plk_${stableHash(c.customerId).toString(16).padStart(8, '0')}`,
    customerId: c.customerId,
    displayName: c.displayName,
    emailMasked: mask(c.email.split('@')[0], 1) + '@' + c.email.split('@')[1],
    mobileMasked: '***-***-' + c.mobile.replace(/\D/g, '').slice(-4),
    enrolledAt: c.enrolledAt,
    network: 'paylink'
  }));
  const byEmail = new Map(fx.customers.map((c, i) => [c.email.toLowerCase(), contacts[i]]));
  const byMobile = new Map(fx.customers.map((c, i) => [c.mobile.replace(/\D/g, ''), contacts[i]]));
  const byToken = new Map(contacts.map((c) => [c.token, c]));

  const payments = new Map<string, Payment>();
  const byIdempotency = new Map<string, Payment>();
  const requests = new Map<string, MoneyRequest>();
  const deliveries: WebhookDelivery[] = [];

  const requireApiKey = (req: import('express').Request, res: import('express').Response): boolean => {
    if (!req.header('x-paylink-participant')) {
      sendError(res, 401, 'PARTICIPANT_REQUIRED', 'X-PayLink-Participant header (participant id) missing');
      return false;
    }
    return true;
  };

  const settle = (payment: Payment) => {
    setTimeout(async () => {
      if (payment.status !== 'PENDING') return;
      // amounts ending in .13 are returned by the receiving institution. Sandbox convention, documented.
      const returned = payment.amountMinor % 100 === 13;
      payment.status = returned ? 'RETURNED' : 'SETTLED';
      payment.settledAt = new Date().toISOString();
      if (returned) payment.failureReason = 'R03 no account/unable to locate';
      log.info({ event: 'paylink.settled', paymentId: payment.paymentId, status: payment.status });
      const url = payment.webhook || process.env.PAYLINK_DEFAULT_WEBHOOK;
      if (url) {
        const payload = { eventType: `payment.${payment.status.toLowerCase()}`, paymentId: payment.paymentId, idempotencyKey: payment.idempotencyKey,
          status: payment.status, amountMinor: payment.amountMinor, settledAt: payment.settledAt, failureReason: payment.failureReason };
        deliveries.push(await deliverWebhook(log, url, payload.eventType, payload, { 'x-paylink-signature': `sha256=${stableHash(JSON.stringify(payload)).toString(16)}` }));
      }
    }, options.settleAfterMs).unref();
  };

  app.get('/v1/contacts/lookup', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const email = typeof req.query.email === 'string' ? req.query.email.toLowerCase() : undefined;
    const phone = typeof req.query.phone === 'string' ? req.query.phone.replace(/\D/g, '') : undefined;
    if (!email && !phone) {
      sendError(res, 400, 'BAD_REQUEST', 'email or phone is required');
      return;
    }
    const contact = (email && byEmail.get(email)) || (phone && byMobile.get(phone.length === 11 && phone.startsWith('1') ? phone.slice(1) : phone));
    if (!contact) {
      // the network says "not enrolled", never "not found", so you cannot probe the directory
      res.json({ enrolled: false });
      return;
    }
    res.json({ enrolled: true, contact });
  });

  app.get('/v1/contacts/:token', (req, res) => {
    const contact = byToken.get(req.params.token);
    if (!contact) {
      sendError(res, 404, 'CONTACT_NOT_FOUND', 'unknown recipient token');
      return;
    }
    res.json(contact);
  });

  app.post('/v1/payments', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const key = req.header('idempotency-key') || req.header('x-idempotency-key');
    if (!key) {
      sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required on POST /v1/payments');
      return;
    }
    const body = req.body as { senderCustomerId?: string; recipientToken?: string; amountMinor?: number; memo?: string; webhook?: string; requestId?: string };
    const existing = byIdempotency.get(key);
    if (existing) {
      res.status(200).set('idempotent-replayed', 'true').json(existing);
      return;
    }
    if (!body.senderCustomerId || !body.recipientToken || typeof body.amountMinor !== 'number' || body.amountMinor <= 0) {
      sendError(res, 400, 'BAD_REQUEST', 'senderCustomerId, recipientToken and positive amountMinor are required');
      return;
    }
    if (!byToken.has(body.recipientToken)) {
      sendError(res, 404, 'CONTACT_NOT_FOUND', 'unknown recipient token');
      return;
    }
    if (body.amountMinor > 2_500_00) {
      sendError(res, 422, 'LIMIT_EXCEEDED', 'network per-transaction limit is $2,500.00');
      return;
    }
    const payment: Payment = {
      paymentId: `pay_${randomUUID()}`, idempotencyKey: key, senderCustomerId: body.senderCustomerId, recipientToken: body.recipientToken,
      amountMinor: body.amountMinor, currency: 'USD', memo: (body.memo || '').slice(0, 140), status: 'PENDING',
      createdAt: new Date().toISOString(), settledAt: null, webhook: body.webhook
    };
    payments.set(payment.paymentId, payment);
    byIdempotency.set(key, payment);
    if (body.requestId && requests.has(body.requestId)) {
      const r = requests.get(body.requestId) as MoneyRequest;
      r.status = 'PAID';
      r.paymentId = payment.paymentId;
    }
    log.info({ event: 'paylink.sent', paymentId: payment.paymentId, amountMinor: payment.amountMinor, correlationId: res.locals.correlationId });
    settle(payment);
    res.status(201).json(payment);
  });

  app.get('/v1/payments/:paymentId', (req, res) => {
    const p = payments.get(req.params.paymentId);
    if (!p) {
      sendError(res, 404, 'PAYMENT_NOT_FOUND', 'no such payment');
      return;
    }
    res.json(p);
  });

  app.get('/v1/payments', (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    res.json([...payments.values()].filter((p) => !customerId || p.senderCustomerId === customerId || byToken.get(p.recipientToken)?.customerId === customerId));
  });

  app.post('/v1/requests', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const body = req.body as { requesterCustomerId?: string; payerToken?: string; amountMinor?: number; memo?: string };
    if (!body.requesterCustomerId || !body.payerToken || typeof body.amountMinor !== 'number' || body.amountMinor <= 0) {
      sendError(res, 400, 'BAD_REQUEST', 'requesterCustomerId, payerToken and positive amountMinor are required');
      return;
    }
    if (!byToken.has(body.payerToken)) {
      sendError(res, 404, 'CONTACT_NOT_FOUND', 'unknown payer token');
      return;
    }
    const r: MoneyRequest = {
      requestId: `req_${randomUUID()}`, requesterCustomerId: body.requesterCustomerId, payerToken: body.payerToken, amountMinor: body.amountMinor,
      memo: (body.memo || '').slice(0, 140), status: 'OPEN', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString()
    };
    requests.set(r.requestId, r);
    res.status(201).json(r);
  });

  app.get('/v1/requests', (req, res) => {
    const token = typeof req.query.payerToken === 'string' ? req.query.payerToken : undefined;
    const requester = typeof req.query.requesterCustomerId === 'string' ? req.query.requesterCustomerId : undefined;
    res.json([...requests.values()].filter((r) => (!token || r.payerToken === token) && (!requester || r.requesterCustomerId === requester)));
  });

  app.post('/v1/requests/:requestId/decline', (req, res) => {
    const r = requests.get(req.params.requestId);
    if (!r) {
      sendError(res, 404, 'REQUEST_NOT_FOUND', 'no such request');
      return;
    }
    if (r.status !== 'OPEN') {
      sendError(res, 409, 'REQUEST_CLOSED', `request is ${r.status}`);
      return;
    }
    r.status = 'DECLINED';
    res.json(r);
  });

  app.get('/debug/webhooks', (_req, res) => res.json(deliveries.slice(-50)));
  app.get('/debug/contacts', (_req, res) => res.json(contacts));

  return mock;
}
