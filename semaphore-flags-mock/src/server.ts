import { createMockApp, fixtures, MockApp, sendError, stableHash } from '@meridian/mock-kit';

/**
 * Semaphore feature flags. Evaluation order: kill switch -> user override -> segment rule ->
 * percentage rollout (hash of flag+user, stable) -> environment default. Same algorithm the
 * @meridian/semaphore-client uses offline, so the client and the server agree when the network
 * is flapping (SEMA-77, the "flags flicker on reconnect" defect).
 *
 * Environments: local, dev, uat, prod. Segments come from the fixture customer segment plus
 * `staff` (LDAP users) and `beta` (a stable 10 percent of consumers).
 */

type Environment = 'local' | 'dev' | 'uat' | 'prod';
type Segment = 'consumer' | 'small-business' | 'treasury' | 'staff' | 'beta' | 'anonymous';

interface FlagRule {
  segment: Segment;
  value: boolean | string | number;
}

interface FlagEnvConfig {
  enabled: boolean;
  default: boolean | string | number;
  rules: FlagRule[];
  rollout?: number;
  overrides?: Record<string, boolean | string | number>;
}

interface Flag {
  key: string;
  description: string;
  owner: string;
  ticket: string;
  kind: 'boolean' | 'string' | 'number';
  createdAt: string;
  environments: Record<Environment, FlagEnvConfig>;
}

const ENVS: Environment[] = ['local', 'dev', 'uat', 'prod'];

function env(enabled: boolean, def: boolean | string | number, rules: FlagRule[] = [], rollout?: number): FlagEnvConfig {
  return { enabled, default: def, rules, rollout, overrides: {} };
}

const FLAGS: Flag[] = [
  {
    key: 'paylink_request_money', description: 'Request money through the PayLink network. Retail only until the business risk review closes.',
    owner: 'payments-digital', ticket: 'MOL-4102', kind: 'boolean', createdAt: '2023-03-14',
    environments: {
      local: env(true, true), dev: env(true, true), uat: env(true, false, [{ segment: 'consumer', value: true }, { segment: 'staff', value: true }]),
      prod: env(true, false, [{ segment: 'staff', value: true }, { segment: 'beta', value: true }], 25)
    }
  },
  {
    key: 'new_dashboard_v2', description: 'Canopy 2.x dashboard layout in Meridian Online. Percentage rollout in prod.',
    owner: 'retail-digital', ticket: 'MOL-3990', kind: 'boolean', createdAt: '2022-11-02',
    environments: {
      local: env(true, true), dev: env(true, true), uat: env(true, true), prod: env(true, false, [{ segment: 'staff', value: true }], 50)
    }
  },
  {
    key: 'iris_widget_enabled', description: 'Iris conversational assistant widget. Off for treasury pending the model risk sign off.',
    owner: 'iris-platform', ticket: 'IRIS-210', kind: 'boolean', createdAt: '2024-02-19',
    environments: {
      local: env(true, true, [{ segment: 'treasury', value: false }]), dev: env(true, true, [{ segment: 'treasury', value: false }]),
      uat: env(true, true, [{ segment: 'treasury', value: false }]), prod: env(true, false, [{ segment: 'staff', value: true }, { segment: 'beta', value: true }])
    }
  },
  {
    key: 'transfer_limit_uplift', description: 'Raise the daily external transfer limit for small business. Value is the new limit in minor units.',
    owner: 'business-digital', ticket: 'MBZ-1534', kind: 'number', createdAt: '2023-09-28',
    environments: {
      local: env(true, 1_000_000_00, [{ segment: 'small-business', value: 2_500_000_00 }, { segment: 'treasury', value: 10_000_000_00 }]),
      dev: env(true, 1_000_000_00, [{ segment: 'small-business', value: 2_500_000_00 }, { segment: 'treasury', value: 10_000_000_00 }]),
      uat: env(true, 1_000_000_00, [{ segment: 'small-business', value: 2_500_000_00 }]),
      prod: env(true, 1_000_000_00, [{ segment: 'small-business', value: 1_500_000_00 }])
    }
  },
  {
    key: 'statements_pdf_v2', description: 'documents-service PDF renderer v2 (the one that handles the footer). Left over from PLAT-2610; nobody has cleaned it up.',
    owner: 'platform-services', ticket: 'PLAT-2610', kind: 'boolean', createdAt: '2021-06-08',
    environments: { local: env(true, true), dev: env(true, true), uat: env(true, true), prod: env(true, true) }
  },
  {
    key: 'maintenance_banner', description: 'Text shown in the global banner. Empty string hides it.',
    owner: 'retail-digital', ticket: 'MOL-2201', kind: 'string', createdAt: '2020-12-01',
    environments: { local: env(true, ''), dev: env(true, ''), uat: env(true, 'UAT refresh Saturday 02:00-06:00 ET'), prod: env(true, '') }
  }
];

export interface EvaluationContext {
  userId?: string;
  segment?: Segment;
  attributes?: Record<string, unknown>;
}

export function segmentFor(userId: string | undefined, hinted: string | undefined): Segment {
  if (hinted && ['consumer', 'small-business', 'treasury', 'staff', 'beta', 'anonymous'].includes(hinted)) return hinted as Segment;
  if (!userId) return 'anonymous';
  const customer = fixtures().customers.find((c) => c.customerId === userId || c.email === userId);
  if (customer) return customer.segment;
  if (/^(svc-|emp|staff)/i.test(userId)) return 'staff';
  return 'consumer';
}

function inBeta(userId: string | undefined): boolean {
  return !!userId && stableHash(`beta:${userId}`) % 100 < 10;
}

export function evaluate(flag: Flag, environment: Environment, ctx: EvaluationContext): { value: boolean | string | number; reason: string } {
  const cfg = flag.environments[environment];
  if (!cfg.enabled) return { value: flag.kind === 'boolean' ? false : cfg.default, reason: 'KILL_SWITCH' };
  if (ctx.userId && cfg.overrides && ctx.userId in cfg.overrides) return { value: cfg.overrides[ctx.userId], reason: 'USER_OVERRIDE' };
  const segment = segmentFor(ctx.userId, ctx.segment);
  const rule = cfg.rules.find((r) => r.segment === segment) || (inBeta(ctx.userId) ? cfg.rules.find((r) => r.segment === 'beta') : undefined);
  if (rule) return { value: rule.value, reason: `SEGMENT_RULE:${rule.segment}` };
  if (typeof cfg.rollout === 'number' && flag.kind === 'boolean') {
    const bucket = stableHash(`${flag.key}:${ctx.userId || 'anonymous'}`) % 100;
    return { value: bucket < cfg.rollout, reason: `ROLLOUT:${bucket}<${cfg.rollout}` };
  }
  return { value: cfg.default, reason: 'DEFAULT' };
}

export function buildServer(): MockApp {
  const mock = createMockApp('semaphore-flags-mock');
  const { app, log } = mock;
  const flags = new Map(FLAGS.map((f) => [f.key, f]));
  const sseClients = new Set<import('express').Response>();

  const parseEnv = (raw: unknown, res: import('express').Response): Environment | undefined => {
    const e = typeof raw === 'string' ? raw : 'local';
    if (!ENVS.includes(e as Environment)) {
      sendError(res, 400, 'UNKNOWN_ENVIRONMENT', `environment must be one of ${ENVS.join(', ')}`);
      return undefined;
    }
    return e as Environment;
  };

  const contextFrom = (req: import('express').Request): EvaluationContext => {
    const body = (req.method === 'POST' ? req.body : {}) as EvaluationContext & { user?: { key?: string; segment?: string } };
    return {
      userId: body.userId || body.user?.key || (typeof req.query.userId === 'string' ? req.query.userId : undefined) || req.header('x-semaphore-user') || undefined,
      segment: (body.segment || body.user?.segment || (typeof req.query.segment === 'string' ? req.query.segment : undefined) || req.header('x-semaphore-segment')) as Segment | undefined
    };
  };

  const broadcast = (payload: unknown) => {
    for (const c of sseClients) c.write(`event: flags\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  app.get('/api/v1/flags', (req, res) => {
    const environment = parseEnv(req.query.environment, res);
    if (!environment) return;
    res.json({ environment, flags: FLAGS.map((f) => ({ key: f.key, description: f.description, owner: f.owner, ticket: f.ticket, kind: f.kind, ...f.environments[environment] })) });
  });

  const evaluateAll = (req: import('express').Request, res: import('express').Response) => {
    const environment = parseEnv(req.query.environment || (req.body as { environment?: string })?.environment, res);
    if (!environment) return;
    const ctx = contextFrom(req);
    const segment = segmentFor(ctx.userId, ctx.segment);
    const out: Record<string, boolean | string | number> = {};
    const reasons: Record<string, string> = {};
    for (const f of FLAGS) {
      const r = evaluate(f, environment, ctx);
      out[f.key] = r.value;
      reasons[f.key] = r.reason;
    }
    res.json({ environment, userId: ctx.userId || null, segment, flags: out, reasons, evaluatedAt: new Date().toISOString() });
  };
  app.get('/api/v1/evaluate', evaluateAll);
  app.post('/api/v1/evaluate', evaluateAll);

  app.get('/api/v1/flags/:key/evaluate', (req, res) => {
    const flag = flags.get(req.params.key);
    if (!flag) {
      sendError(res, 404, 'FLAG_NOT_FOUND', `no flag ${req.params.key}`);
      return;
    }
    const environment = parseEnv(req.query.environment, res);
    if (!environment) return;
    const ctx = contextFrom(req);
    res.json({ key: flag.key, environment, ...evaluate(flag, environment, ctx), segment: segmentFor(ctx.userId, ctx.segment) });
  });

  // Admin: toggle / override. No auth, it is a mock; the real Semaphore needs SSO + a change ticket.
  app.put('/api/v1/flags/:key/environments/:environment', (req, res) => {
    const flag = flags.get(req.params.key);
    const environment = parseEnv(req.params.environment, res);
    if (!environment) return;
    if (!flag) {
      sendError(res, 404, 'FLAG_NOT_FOUND', `no flag ${req.params.key}`);
      return;
    }
    const body = req.body as Partial<FlagEnvConfig>;
    const cfg = flag.environments[environment];
    if (typeof body.enabled === 'boolean') cfg.enabled = body.enabled;
    if (body.default !== undefined) cfg.default = body.default;
    if (Array.isArray(body.rules)) cfg.rules = body.rules;
    if (body.rollout !== undefined) cfg.rollout = body.rollout;
    if (body.overrides) cfg.overrides = { ...cfg.overrides, ...body.overrides };
    log.info({ event: 'semaphore.flag.updated', key: flag.key, environment, by: req.header('x-semaphore-user') || 'anonymous' });
    broadcast({ key: flag.key, environment, config: cfg, updatedAt: new Date().toISOString() });
    res.json({ key: flag.key, environment, ...cfg });
  });

  app.get('/api/v1/stream', (req, res) => {
    res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ flags: FLAGS.map((f) => f.key) })}\n\n`);
    sseClients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
  });

  app.get('/debug/segments', (_req, res) => {
    res.json(fixtures().customers.slice(0, 30).map((c) => ({ customerId: c.customerId, segment: c.segment, beta: inBeta(c.customerId) })));
  });

  return mock;
}
