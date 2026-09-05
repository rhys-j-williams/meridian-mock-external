import { randomUUID } from 'crypto';
import { createMockApp, MockApp } from '@meridian/mock-kit';

/**
 * Vault HTTP API subset: sys/health, auth/token/lookup-self, auth/approle/login, kv-v2 read/write/
 * metadata/list under `secret/`, sys/policies/acl. Enough for spring-cloud-vault and the NestJS
 * common-starter VaultConfigLoader to boot against. Errors use Vault's `{"errors":[...]}` shape
 * because both clients parse it.
 *
 * Seeded values are CHANGEME placeholders (R9). Real Vault is the source of truth in the bank;
 * platform-tooling/vault holds the policies and the agent template.
 */

const ROOT_TOKEN = process.env.VAULT_DEV_ROOT_TOKEN_ID || 'CHANGEME-vault-root-token';

interface Version {
  version: number;
  created_time: string;
  deletion_time: string;
  destroyed: boolean;
  data: Record<string, string>;
}

interface AppRole {
  roleId: string;
  secretId: string;
  policies: string[];
}

const SERVICES = ['bff-retail', 'bff-business', 'beacon-notifications', 'alerts-preferences', 'txn-posting', 'pii-vault',
  'audit-trail', 'entitlements', 'bedrock-adapter', 'iris-orchestrator', 'documents-service', 'statements-api', 'exposure-calc'];

function seedSecrets(): Record<string, Record<string, string>> {
  const now = new Date().toISOString();
  const out: Record<string, Record<string, string>> = {
    'meridian/shared/keystone': {
      issuer: 'http://localhost:4400',
      audience: 'api://meridian-digital-channels',
      jwks_uri: 'http://localhost:4400/oauth2/v1/keys'
    },
    'meridian/shared/splunk': { hec_url: 'http://localhost:4606/services/collector/event', hec_token: 'CHANGEME-hec-token' },
    'meridian/shared/redis': { host: 'localhost', port: '6379', password: 'CHANGEME-redis-password' },
    'meridian/shared/redpanda': { bootstrap_servers: 'localhost:9092', sasl_username: 'meridian', sasl_password: 'CHANGEME-redpanda-password' },
    'meridian/shared/ibm-mq': { queue_manager: 'MTBQM01', channel: 'DEV.APP.SVRCONN', host: 'localhost', port: '1414', user: 'app', password: 'CHANGEME-mq-app-password' },
    'meridian/shared/artemis': { url: 'tcp://localhost:61616', user: 'artemis', password: 'CHANGEME-artemis' },
    'meridian/shared/ldap': { url: 'ldap://localhost:4609', bind_dn: 'cn=svc-beacon,ou=service-accounts,dc=meridiantrust,dc=example', bind_password: 'CHANGEME-ldap-bind' },
    'meridian/vendors/aggregio': { client_id: 'CHANGEME-aggregio-client-id', secret: 'CHANGEME-aggregio-secret', base_url: 'http://localhost:4601' },
    'meridian/vendors/tickerhaus': { api_key: 'CHANGEME-tickerhaus-api-key', base_url: 'http://localhost:4602' },
    'meridian/vendors/triscore': { subscriber_code: 'CHANGEME-triscore-subscriber', base_url: 'http://localhost:4603' },
    'meridian/vendors/paylink': { participant_id: 'CHANGEME-paylink-participant', signing_key: 'CHANGEME-paylink-signing-key', base_url: 'http://localhost:4604' },
    'meridian/vendors/lantern': { write_key: 'CHANGEME-lantern-write-key', collector_url: 'http://localhost:4607' },
    'meridian/vendors/semaphore': { sdk_key: 'CHANGEME-semaphore-sdk-key', base_url: 'http://localhost:4608' }
  };
  for (const svc of SERVICES) {
    out[`meridian/services/${svc}`] = {
      keystone_client_id: svc,
      keystone_client_secret: `CHANGEME-${svc}-client-secret`,
      db_username: `${svc.replace(/-/g, '_')}_app`,
      db_password: `CHANGEME-${svc}-db-password`,
      seeded_at: now
    };
  }
  out['meridian/services/pii-vault'].tokenisation_key = 'CHANGEME-pii-tokenisation-key-32-bytes';
  out['meridian/services/documents-service'].pdf_signing_cert_alias = 'meridian-documents-2024';
  return out;
}

export function buildServer(): MockApp {
  const mock = createMockApp('vault-mock');
  const { app, log } = mock;
  const kv = new Map<string, Version[]>();
  const tokens = new Map<string, { policies: string[]; display: string; ttl: number; created: number }>();
  const roles = new Map<string, AppRole>();

  for (const [path, data] of Object.entries(seedSecrets())) {
    kv.set(path, [{ version: 1, created_time: new Date().toISOString(), deletion_time: '', destroyed: false, data }]);
  }
  tokens.set(ROOT_TOKEN, { policies: ['root'], display: 'token-root', ttl: 0, created: Date.now() });
  for (const svc of SERVICES) {
    roles.set(svc, { roleId: `role-${svc}`, secretId: `CHANGEME-${svc}-secret-id`, policies: ['default', `meridian-${svc}`] });
  }

  const policies: Record<string, string> = { root: '', default: 'path "auth/token/lookup-self" { capabilities = ["read"] }' };
  for (const svc of SERVICES) {
    policies[`meridian-${svc}`] = `path "secret/data/meridian/services/${svc}" { capabilities = ["read"] }\npath "secret/data/meridian/shared/*" { capabilities = ["read"] }\npath "secret/data/meridian/vendors/*" { capabilities = ["read"] }`;
  }

  const vaultError = (res: import('express').Response, status: number, ...errors: string[]) => res.status(status).json({ errors });

  const auth = (req: import('express').Request, res: import('express').Response) => {
    const token = req.header('x-vault-token') || req.header('authorization')?.replace(/^Bearer /i, '');
    const t = token ? tokens.get(token) : undefined;
    if (!t) {
      vaultError(res, 403, 'permission denied');
      return undefined;
    }
    return t;
  };

  app.get('/v1/sys/health', (_req, res) => {
    res.json({ initialized: true, sealed: false, standby: false, performance_standby: false, replication_performance_mode: 'disabled',
      replication_dr_mode: 'disabled', server_time_utc: Math.floor(Date.now() / 1000), version: '1.13.3-mock', cluster_name: 'vault-mock-local' });
  });
  app.get('/v1/sys/seal-status', (_req, res) => res.json({ type: 'shamir', sealed: false, t: 1, n: 1, progress: 0, version: '1.13.3-mock' }));

  app.post('/v1/auth/approle/login', (req, res) => {
    const { role_id, secret_id } = req.body as { role_id?: string; secret_id?: string };
    const role = [...roles.values()].find((r) => r.roleId === role_id && r.secretId === secret_id);
    if (!role) {
      vaultError(res, 400, 'invalid role or secret ID');
      return;
    }
    const token = `hvs.${randomUUID().replace(/-/g, '')}`;
    tokens.set(token, { policies: role.policies, display: `approle-${role.roleId}`, ttl: 3600, created: Date.now() });
    log.info({ event: 'vault.approle.login', role: role.roleId });
    res.json({ auth: { client_token: token, accessor: randomUUID(), policies: role.policies, token_policies: role.policies,
      metadata: { role_name: role.roleId.replace(/^role-/, '') }, lease_duration: 3600, renewable: true, token_type: 'service' } });
  });

  app.get('/v1/auth/token/lookup-self', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    res.json({ data: { policies: t.policies, display_name: t.display, ttl: t.ttl, creation_time: Math.floor(t.created / 1000), renewable: t.ttl > 0 } });
  });

  app.post('/v1/auth/token/renew-self', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    res.json({ auth: { client_token: req.header('x-vault-token'), policies: t.policies, lease_duration: t.ttl, renewable: t.ttl > 0 } });
  });

  app.post('/v1/auth/token/create', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    if (!t.policies.includes('root')) {
      vaultError(res, 403, 'permission denied');
      return;
    }
    const body = req.body as { policies?: string[]; display_name?: string; ttl?: string };
    const token = `hvs.${randomUUID().replace(/-/g, '')}`;
    tokens.set(token, { policies: body.policies || ['default'], display: body.display_name || 'token', ttl: 3600, created: Date.now() });
    res.json({ auth: { client_token: token, policies: body.policies || ['default'], lease_duration: 3600, renewable: true } });
  });

  app.get('/v1/sys/policies/acl', (req, res) => {
    if (!auth(req, res)) return;
    const keys = Object.keys(policies);
    res.json({ data: { keys, policies: keys }, keys });
  });
  app.get('/v1/sys/policies/acl/:name', (req, res) => {
    if (!auth(req, res)) return;
    if (!(req.params.name in policies)) {
      vaultError(res, 404);
      return;
    }
    res.json({ data: { name: req.params.name, policy: policies[req.params.name] } });
  });

  const canRead = (t: { policies: string[] }, path: string) => t.policies.includes('root')
    || path.startsWith('meridian/shared/') || path.startsWith('meridian/vendors/')
    || t.policies.some((p) => p.startsWith('meridian-') && path === `meridian/services/${p.slice('meridian-'.length)}`);

  app.get('/v1/secret/data/*', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    const path = (req.params as unknown as Record<string, string>)['0'];
    if (!canRead(t, path)) {
      vaultError(res, 403, `1 error occurred:\n\t* permission denied\n\n`);
      return;
    }
    const versions = kv.get(path);
    if (!versions) {
      res.status(404).json({ errors: [] });
      return;
    }
    const wanted = req.query.version ? Number(req.query.version) : versions.length;
    const v = versions[wanted - 1];
    if (!v || v.destroyed) {
      res.status(404).json({ errors: [] });
      return;
    }
    res.json({ request_id: randomUUID(), lease_id: '', renewable: false, lease_duration: 0,
      data: { data: v.data, metadata: { created_time: v.created_time, custom_metadata: null, deletion_time: v.deletion_time, destroyed: v.destroyed, version: v.version } } });
  });

  app.post('/v1/secret/data/*', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    if (!t.policies.includes('root')) {
      vaultError(res, 403, 'permission denied');
      return;
    }
    const path = (req.params as unknown as Record<string, string>)['0'];
    const body = req.body as { data?: Record<string, string>; options?: { cas?: number } };
    if (!body.data || typeof body.data !== 'object') {
      vaultError(res, 400, 'no data provided');
      return;
    }
    const versions = kv.get(path) || [];
    if (body.options && typeof body.options.cas === 'number' && body.options.cas !== versions.length) {
      vaultError(res, 400, 'check-and-set parameter did not match the current version');
      return;
    }
    const v: Version = { version: versions.length + 1, created_time: new Date().toISOString(), deletion_time: '', destroyed: false, data: body.data };
    versions.push(v);
    kv.set(path, versions);
    log.info({ event: 'vault.kv.write', path, version: v.version });
    res.json({ data: { created_time: v.created_time, deletion_time: '', destroyed: false, version: v.version } });
  });

  app.delete('/v1/secret/data/*', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    const versions = kv.get((req.params as unknown as Record<string, string>)['0']);
    if (versions && versions.length > 0) versions[versions.length - 1].deletion_time = new Date().toISOString();
    res.status(204).end();
  });

  app.get('/v1/secret/metadata/*', (req, res) => {
    const t = auth(req, res);
    if (!t) return;
    const path = (req.params as unknown as Record<string, string>)['0'];
    if (req.query.list === 'true') {
      const prefix = path.endsWith('/') || path.length === 0 ? path : path + '/';
      const keys = new Set<string>();
      for (const k of kv.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const i = rest.indexOf('/');
          keys.add(i === -1 ? rest : rest.slice(0, i + 1));
        }
      }
      if (keys.size === 0) {
        res.status(404).json({ errors: [] });
        return;
      }
      res.json({ data: { keys: [...keys].sort() } });
      return;
    }
    const versions = kv.get(path);
    if (!versions) {
      res.status(404).json({ errors: [] });
      return;
    }
    res.json({ data: { current_version: versions.length, max_versions: 10, oldest_version: 1, versions: Object.fromEntries(versions.map((v) => [v.version, { created_time: v.created_time, deletion_time: v.deletion_time, destroyed: v.destroyed }])) } });
  });
  // the Vault CLI sends the non-standard LIST verb; Node's parser rejects it, so GET ?list=true is the only form here

  app.get('/v1/sys/mounts', (req, res) => {
    if (!auth(req, res)) return;
    res.json({ data: { 'secret/': { type: 'kv', options: { version: '2' }, description: 'key/value secret storage' } } });
  });

  app.get('/debug/approles', (_req, res) => res.json([...roles.values()].map((r) => ({ role: r.roleId, secretId: r.secretId, policies: r.policies }))));

  return mock;
}
