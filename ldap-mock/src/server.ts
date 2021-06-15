import * as ldap from 'ldapjs';
import { createMockApp, MockApp } from '@meridian/mock-kit';
import { BASE_DN, buildDirectory, Entry, normaliseDn, passwordFor } from './directory';

/**
 * LDAP on 4609 (ldapjs server) for beacon-notifications' admin login and the Beacon console
 * group checks. The same process also answers HTTP on LDAP_HTTP_PORT (default 14609, debug only,
 * deliberately outside the PORTS.md range) for /health and /debug/entries, because you cannot
 * curl LDAP and estate-up wants a health URL for every mock.
 *
 * Supports: anonymous bind (read only), simple bind for staff and service accounts, base/one/sub
 * search with ldapjs filters, and nothing else. Modify returns unwillingToPerform; the real
 * directory is read only from the app network too.
 */

interface LdapSearchReq {
  dn: { toString(): string };
  scope: 'base' | 'one' | 'sub';
  filter: { matches(obj: Record<string, unknown>): boolean };
  attributes?: string[];
}
interface LdapSearchRes {
  send(entry: { dn: string; attributes: Record<string, string | string[]> }): void;
  end(): void;
}
interface LdapBindReq {
  dn: { toString(): string };
  credentials: string;
}
interface LdapBindRes {
  end(): void;
}

export interface LdapMock extends MockApp {
  ldapServer: ldap.Server;
  entries: Entry[];
  listenLdap(port: number): Promise<void>;
}

export function buildServer(): LdapMock {
  const mock = createMockApp('ldap-mock');
  const { app, log } = mock;
  const entries = buildDirectory();
  const byDn = new Map(entries.map((e) => [normaliseDn(e.dn), e]));
  let binds = 0;
  let failedBinds = 0;
  let searches = 0;

  const server = ldap.createServer();

  server.bind(BASE_DN, (req: LdapBindReq, res: LdapBindRes, next: (err?: unknown) => void) => {
    const dn = normaliseDn(req.dn.toString());
    const entry = byDn.get(dn);
    const expected = passwordFor(dn);
    if (!entry || !expected || req.credentials !== expected) {
      failedBinds += 1;
      log.warn({ event: 'ldap.bind.failed', dn });
      return next(new ldap.InvalidCredentialsError());
    }
    binds += 1;
    log.info({ event: 'ldap.bind', dn });
    res.end();
    return next();
  });

  const matchesScope = (base: string, dn: string, scope: string): boolean => {
    if (dn === base) return scope !== 'one';
    if (scope === 'base' || !dn.endsWith(',' + base)) return false;
    const rest = dn.slice(0, dn.length - base.length - 1);
    return scope === 'sub' || !rest.includes(',');
  };

  server.search(BASE_DN, (req: LdapSearchReq, res: LdapSearchRes, next: (err?: unknown) => void) => {
    searches += 1;
    const base = normaliseDn(req.dn.toString());
    if (!byDn.has(base)) {
      return next(new ldap.NoSuchObjectError(base));
    }
    let sent = 0;
    for (const e of entries) {
      const dn = normaliseDn(e.dn);
      if (!matchesScope(base, dn, req.scope)) continue;
      // ldapjs filters match case-insensitively on attribute names but we keep the AD-ish casing
      const attrs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(e.attributes)) {
        attrs[k] = v;
        attrs[k.toLowerCase()] = v;
      }
      if (req.filter.matches(attrs)) {
        res.send({ dn: e.dn, attributes: e.attributes });
        sent += 1;
      }
    }
    log.info({ event: 'ldap.search', base, scope: req.scope, filter: String(req.filter), results: sent });
    res.end();
    return next();
  });

  // Root DSE so ldapsearch -x -b "" -s base works
  server.search('', (req: LdapSearchReq, res: LdapSearchRes, next: () => void) => {
    if (req.scope === 'base') {
      res.send({ dn: '', attributes: { namingContexts: [BASE_DN], supportedLDAPVersion: ['3'], vendorName: 'ldap-mock' } });
    }
    res.end();
    next();
  });

  for (const op of ['modify', 'add', 'del', 'modifyDN'] as const) {
    server[op](BASE_DN, (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next(new ldap.UnwillingToPerformError('directory is read only')));
  }

  app.get('/debug/entries', (req, res) => {
    const ou = typeof req.query.ou === 'string' ? req.query.ou : undefined;
    res.json(entries.filter((e) => !ou || e.dn.includes(`ou=${ou},`)).map((e) => ({ dn: e.dn, ...e.attributes })));
  });
  app.get('/debug/groups/:name/members', (req, res) => {
    const g = entries.find((e) => e.dn.startsWith(`cn=${req.params.name},ou=groups`));
    if (!g) {
      res.status(404).json({ code: 'GROUP_NOT_FOUND' });
      return;
    }
    res.json({ group: g.dn, members: g.attributes.member });
  });
  app.get('/debug/stats', (_req, res) => res.json({ entries: entries.length, binds, failedBinds, searches, baseDn: BASE_DN }));

  return {
    ...mock,
    ldapServer: server,
    entries,
    listenLdap(port: number) {
      return new Promise<void>((resolve) => {
        server.listen(port, () => {
          log.info({ event: 'ldap.started', port, baseDn: BASE_DN, entries: entries.length });
          resolve();
        });
      });
    }
  };
}
