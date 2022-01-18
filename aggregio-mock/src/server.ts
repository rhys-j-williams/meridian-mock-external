import { randomUUID } from 'crypto';
import { createMockApp, deliverWebhook, fixtures, MockApp, sendError, stableHash, WebhookDelivery } from '@meridian/mock-kit';

/**
 * Aggregio: external account aggregation. Shapes follow the Aggregio Connect v2 API as
 * integrated by bff-retail's ExternalAccountsModule (MOL-3312). Institutions are invented;
 * the forbidden strings hook makes sure of that.
 *
 * Flow: POST /v2/link/token -> customer picks institution -> POST /v2/link/exchange with the
 * public token -> access token -> GET /v2/accounts. Balances drift by a deterministic amount
 * on every read so the "balance update" webhook has something to say.
 */

interface Institution {
  institutionId: string;
  name: string;
  logo: string;
  products: string[];
  healthy: boolean;
}

const INSTITUTIONS: Institution[] = [
  { institutionId: 'ins_100001', name: 'Harborline Federal Credit Union', logo: 'harborline.svg', products: ['checking', 'savings'], healthy: true },
  { institutionId: 'ins_100002', name: 'Copperfield National', logo: 'copperfield.svg', products: ['checking', 'savings', 'mortgage'], healthy: true },
  { institutionId: 'ins_100003', name: 'Summit Ridge Bank', logo: 'summitridge.svg', products: ['checking', 'credit'], healthy: true },
  { institutionId: 'ins_100004', name: 'Bluewater Savings', logo: 'bluewater.svg', products: ['savings', 'certificate'], healthy: false },
  { institutionId: 'ins_100005', name: 'Prairie Mutual', logo: 'prairie.svg', products: ['checking', 'auto-loan'], healthy: true },
  { institutionId: 'ins_100006', name: 'Northgate Community Bank', logo: 'northgate.svg', products: ['checking', 'savings', 'credit'], healthy: true },
  { institutionId: 'ins_100007', name: 'Sablewood Trust', logo: 'sablewood.svg', products: ['brokerage'], healthy: true },
  { institutionId: 'ins_100008', name: 'Ironvale Bank', logo: 'ironvale.svg', products: ['checking'], healthy: true }
];

interface LinkSession {
  linkToken: string;
  customerId: string;
  createdAt: string;
  webhook?: string;
  institutionId?: string;
  publicToken?: string;
  exchanged: boolean;
}

interface LinkedItem {
  itemId: string;
  accessToken: string;
  customerId: string;
  institution: Institution;
  webhook?: string;
  reads: number;
  accounts: ExternalAccount[];
}

interface ExternalAccount {
  accountId: string;
  name: string;
  officialName: string;
  type: string;
  subtype: string;
  mask: string;
  balances: { available: number; current: number; limit: number | null; isoCurrencyCode: 'USD' };
}

function externalAccounts(item: { itemId: string; institution: Institution; customerId: string }): ExternalAccount[] {
  const seed = stableHash(item.itemId);
  return item.institution.products.slice(0, 1 + (seed % 3)).map((product, i) => {
    const h = stableHash(`${item.itemId}:${product}`);
    const current = (h % 2_500_000) / 100;
    return {
      accountId: `acc_${item.itemId.slice(4, 12)}${i}`,
      name: `${product.charAt(0).toUpperCase()}${product.slice(1)}`,
      officialName: `${item.institution.name} ${product}`,
      type: product === 'credit' ? 'credit' : product === 'mortgage' || product === 'auto-loan' ? 'loan' : product === 'brokerage' ? 'investment' : 'depository',
      subtype: product,
      mask: String(1000 + (h % 9000)),
      balances: {
        available: product === 'credit' ? Math.round((5000 - current) * 100) / 100 : current,
        current,
        limit: product === 'credit' ? 5000 : null,
        isoCurrencyCode: 'USD'
      }
    };
  });
}

export function buildServer(): MockApp {
  const mock = createMockApp('aggregio-mock');
  const { app, log } = mock;
  const sessions = new Map<string, LinkSession>();
  const items = new Map<string, LinkedItem>();
  const byAccess = new Map<string, LinkedItem>();
  const deliveries: WebhookDelivery[] = [];
  const customers = new Set(fixtures().customers.map((c) => c.customerId));

  // one pre-linked institution for the first consumer customer so the dashboard has a card on first load
  const firstConsumer = fixtures().customers.find((c) => c.segment === 'consumer');
  if (firstConsumer) {
    const item: LinkedItem = {
      itemId: 'itm_seed0001', accessToken: 'access-sandbox-seed0001', customerId: firstConsumer.customerId,
      institution: INSTITUTIONS[1], reads: 0, accounts: []
    };
    item.accounts = externalAccounts(item);
    items.set(item.itemId, item);
    byAccess.set(item.accessToken, item);
  }

  const requireApiKey = (req: import('express').Request, res: import('express').Response): boolean => {
    const key = req.header('aggregio-client-id');
    if (!key) {
      sendError(res, 401, 'MISSING_CLIENT_ID', 'Aggregio-Client-Id header required');
      return false;
    }
    return true;
  };

  app.get('/v2/institutions/search', (req, res) => {
    const q = String(req.query.query || '').toLowerCase();
    const products = String(req.query.products || '').split(',').filter(Boolean);
    const hits = INSTITUTIONS.filter((i) => (q.length === 0 || i.name.toLowerCase().includes(q))
      && (products.length === 0 || products.some((p) => i.products.includes(p))));
    res.json({ institutions: hits, requestId: res.locals.correlationId });
  });

  app.get('/v2/institutions/:id', (req, res) => {
    const inst = INSTITUTIONS.find((i) => i.institutionId === req.params.id);
    if (!inst) {
      sendError(res, 404, 'INSTITUTION_NOT_FOUND', `no institution ${req.params.id}`);
      return;
    }
    res.json(inst);
  });

  app.post('/v2/link/token', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const { customerId, webhook } = req.body as { customerId?: string; webhook?: string };
    if (!customerId || !customers.has(customerId)) {
      sendError(res, 400, 'INVALID_CUSTOMER', 'customerId must be a fixture customer');
      return;
    }
    const session: LinkSession = { linkToken: `link-sandbox-${randomUUID()}`, customerId, createdAt: new Date().toISOString(), webhook, exchanged: false };
    sessions.set(session.linkToken, session);
    res.json({ linkToken: session.linkToken, expiration: new Date(Date.now() + 30 * 60_000).toISOString(), requestId: res.locals.correlationId });
  });

  // The hosted Link UI is a vendor iframe in production. Here it is one POST.
  app.post('/v2/link/:linkToken/select', (req, res) => {
    const session = sessions.get(req.params.linkToken);
    const inst = INSTITUTIONS.find((i) => i.institutionId === (req.body as { institutionId?: string }).institutionId);
    if (!session) {
      sendError(res, 404, 'INVALID_LINK_TOKEN', 'unknown or expired link token');
      return;
    }
    if (!inst) {
      sendError(res, 400, 'INVALID_INSTITUTION', 'institutionId required');
      return;
    }
    if (!inst.healthy) {
      sendError(res, 503, 'INSTITUTION_DOWN', `${inst.name} is not currently responding to Aggregio`);
      return;
    }
    session.institutionId = inst.institutionId;
    session.publicToken = `public-sandbox-${randomUUID()}`;
    res.json({ publicToken: session.publicToken, institution: inst });
  });

  app.post('/v2/link/exchange', (req, res) => {
    if (!requireApiKey(req, res)) return;
    const { publicToken } = req.body as { publicToken?: string };
    const session = [...sessions.values()].find((s) => s.publicToken === publicToken);
    if (!session || !session.institutionId) {
      sendError(res, 400, 'INVALID_PUBLIC_TOKEN', 'public token unknown, expired or already exchanged');
      return;
    }
    if (session.exchanged) {
      sendError(res, 400, 'INVALID_PUBLIC_TOKEN', 'public token already exchanged');
      return;
    }
    session.exchanged = true;
    const item: LinkedItem = {
      itemId: `itm_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      customerId: session.customerId,
      institution: INSTITUTIONS.find((i) => i.institutionId === session.institutionId) as Institution,
      webhook: session.webhook,
      reads: 0,
      accounts: []
    };
    item.accounts = externalAccounts(item);
    items.set(item.itemId, item);
    byAccess.set(item.accessToken, item);
    log.info({ event: 'aggregio.item.linked', itemId: item.itemId, institutionId: item.institution.institutionId, customerId: item.customerId });
    res.json({ accessToken: item.accessToken, itemId: item.itemId, requestId: res.locals.correlationId });
  });

  const itemFromRequest = (req: import('express').Request, res: import('express').Response): LinkedItem | undefined => {
    const token = (req.body as { accessToken?: string })?.accessToken || req.header('authorization')?.replace(/^Bearer /i, '');
    const item = token ? byAccess.get(token) : undefined;
    if (!item) sendError(res, 401, 'INVALID_ACCESS_TOKEN', 'access token not recognised');
    return item;
  };

  const readAccounts = (req: import('express').Request, res: import('express').Response) => {
    const item = itemFromRequest(req, res);
    if (!item) return;
    item.reads += 1;
    // deterministic drift so successive reads differ, like a real aggregator refresh
    for (const a of item.accounts) {
      if (a.type === 'depository') {
        const drift = ((stableHash(`${a.accountId}:${item.reads}`) % 20000) - 10000) / 100;
        a.balances.current = Math.round((a.balances.current + drift) * 100) / 100;
        a.balances.available = a.balances.current;
      }
    }
    res.json({ item: { itemId: item.itemId, institutionId: item.institution.institutionId, institutionName: item.institution.name },
      accounts: item.accounts, requestId: res.locals.correlationId });
  };
  app.post('/v2/accounts/get', readAccounts);
  app.get('/v2/accounts', readAccounts);

  app.post('/v2/accounts/balance/get', (req, res) => {
    const item = itemFromRequest(req, res);
    if (!item) return;
    res.json({ accounts: item.accounts.map((a) => ({ accountId: a.accountId, balances: a.balances })), requestId: res.locals.correlationId });
  });

  app.get('/v2/items', (req, res) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    res.json([...items.values()].filter((i) => !customerId || i.customerId === customerId)
      .map((i) => ({ itemId: i.itemId, customerId: i.customerId, institution: i.institution, accounts: i.accounts.length })));
  });

  app.delete('/v2/items/:itemId', (req, res) => {
    const item = items.get(req.params.itemId);
    if (!item) {
      sendError(res, 404, 'ITEM_NOT_FOUND', 'no such item');
      return;
    }
    items.delete(item.itemId);
    byAccess.delete(item.accessToken);
    res.json({ removed: true });
  });

  // Vendor sandbox convenience: fire the BALANCE_UPDATE webhook on demand.
  app.post('/v2/sandbox/items/:itemId/fire-webhook', async (req, res) => {
    const item = items.get(req.params.itemId);
    if (!item) {
      sendError(res, 404, 'ITEM_NOT_FOUND', 'no such item');
      return;
    }
    const url = (req.body as { webhook?: string })?.webhook || item.webhook || process.env.AGGREGIO_DEFAULT_WEBHOOK;
    if (!url) {
      sendError(res, 400, 'NO_WEBHOOK', 'item has no webhook URL; pass one in the body or set AGGREGIO_DEFAULT_WEBHOOK');
      return;
    }
    const payload = {
      webhookType: 'ACCOUNTS', webhookCode: 'BALANCE_UPDATE', itemId: item.itemId,
      accounts: item.accounts.map((a) => ({ accountId: a.accountId, balances: a.balances })), timestamp: new Date().toISOString()
    };
    const delivery = await deliverWebhook(log, url, 'BALANCE_UPDATE', payload, { 'aggregio-signature': `v1=${stableHash(JSON.stringify(payload)).toString(16)}` });
    deliveries.push(delivery);
    res.json(delivery);
  });

  app.get('/debug/webhooks', (_req, res) => res.json(deliveries.slice(-50)));

  return mock;
}
