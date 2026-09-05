/**
 * @meridian/semaphore-client 1.3.x
 *
 * Owned by platform-engineering. Used by the NestJS BFFs and (via the Angular FeatureFlagGuard)
 * by the front ends. Deliberately dependency free and ES2017 so it loads in the Angular 14 apps
 * without a polyfill argument.
 *
 * Offline evaluation duplicates the server algorithm (kill switch -> override -> segment rule ->
 * rollout bucket -> default) so cached flag definitions evaluate identically when the network is
 * down. If you change one, change both. SEMA-77.
 */

export type FlagValue = boolean | string | number;
export type Environment = 'local' | 'dev' | 'uat' | 'prod';

export interface FlagRule {
  segment: string;
  value: FlagValue;
}

export interface FlagDefinition {
  key: string;
  kind: 'boolean' | 'string' | 'number';
  enabled: boolean;
  default: FlagValue;
  rules: FlagRule[];
  rollout?: number;
  overrides?: Record<string, FlagValue>;
}

export interface EvaluationContext {
  userId?: string;
  segment?: string;
}

export interface SemaphoreClientOptions {
  baseUrl: string;
  environment: Environment;
  /** default 30s. The server also pushes changes on /api/v1/stream if you call connect(). */
  refreshMs?: number;
  fetchImpl?: typeof fetch;
  /** last known good definitions, e.g. from localStorage, used before the first fetch completes */
  bootstrap?: FlagDefinition[];
}

// FNV-1a, matches stableHash in @meridian/mock-kit and the Java StableHash in meridian-commons
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function evaluate(flag: FlagDefinition, ctx: EvaluationContext): FlagValue {
  if (!flag.enabled) return flag.kind === 'boolean' ? false : flag.default;
  if (ctx.userId && flag.overrides && Object.prototype.hasOwnProperty.call(flag.overrides, ctx.userId)) {
    return flag.overrides[ctx.userId];
  }
  const segment = ctx.segment || 'anonymous';
  const rule = flag.rules.find((r) => r.segment === segment)
    || (ctx.userId && stableHash(`beta:${ctx.userId}`) % 100 < 10 ? flag.rules.find((r) => r.segment === 'beta') : undefined);
  if (rule) return rule.value;
  if (typeof flag.rollout === 'number' && flag.kind === 'boolean') {
    return stableHash(`${flag.key}:${ctx.userId || 'anonymous'}`) % 100 < flag.rollout;
  }
  return flag.default;
}

export class SemaphoreClient {
  private definitions = new Map<string, FlagDefinition>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(flags: Record<string, FlagValue>) => void>();
  private lastFetch: Date | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SemaphoreClientOptions) {
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined as unknown as typeof fetch);
    for (const d of options.bootstrap || []) this.definitions.set(d.key, d);
  }

  async refresh(): Promise<void> {
    if (!this.fetchImpl) throw new Error('semaphore-client: no fetch implementation available');
    const res = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/api/v1/flags?environment=${this.options.environment}`);
    if (!res.ok) throw new Error(`semaphore-client: ${res.status} from ${this.options.baseUrl}`);
    const body = (await res.json()) as { flags: FlagDefinition[] };
    this.definitions = new Map(body.flags.map((f) => [f.key, f]));
    this.lastFetch = new Date();
    this.notify();
  }

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.options.refreshMs || 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  isEnabled(key: string, ctx: EvaluationContext = {}, fallback = false): boolean {
    const v = this.variation(key, ctx, fallback);
    return v === true;
  }

  variation<T extends FlagValue>(key: string, ctx: EvaluationContext, fallback: T): T {
    const def = this.definitions.get(key);
    if (!def) return fallback;
    return evaluate(def, ctx) as T;
  }

  allFlags(ctx: EvaluationContext = {}): Record<string, FlagValue> {
    const out: Record<string, FlagValue> = {};
    for (const d of this.definitions.values()) out[d.key] = evaluate(d, ctx);
    return out;
  }

  snapshot(): FlagDefinition[] {
    return [...this.definitions.values()];
  }

  lastRefreshedAt(): Date | undefined {
    return this.lastFetch;
  }

  onChange(listener: (flags: Record<string, FlagValue>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const flags = this.allFlags();
    for (const l of this.listeners) l(flags);
  }
}
