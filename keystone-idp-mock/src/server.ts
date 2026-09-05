import { randomBytes, randomUUID } from 'crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createMockApp, MockApp, Request, Response, sendError } from '@meridian/mock-kit';
import { API_AUDIENCE, findClient, OidcClient } from './clients';
import { atHash, createSigningKeys, s256, sign, SigningKeys } from './keys';
import { errorPage, loggedOutPage, loginPage, mfaPage } from './pages';
import { samlMetadata, samlResponsePage } from './saml';
import { allUsers, findUser, KeystoneUser, MFA_CODE, PASSWORD } from './users';

export interface ServerOptions {
  issuer: string;
}

/** An authorization request in flight. Lives from /authorize until the code is redeemed. */
interface Transaction {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  responseMode?: string;
  user?: KeystoneUser;
  passwordAt?: number;
  mfaAt?: number;
  amr: string[];
  code?: string;
  createdAt: number;
}

interface Session {
  id: string;
  user: KeystoneUser;
  amr: string[];
  mfaAt: number;
  createdAt: number;
}

interface RefreshToken {
  token: string;
  clientId: string;
  user: KeystoneUser;
  scope: string[];
  amr: string[];
  mfaAt: number;
  nonce?: string;
}

const ID_TOKEN_TTL = 3600;
const REFRESH_TTL_MS = 8 * 3600 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE = 'KEYSTONE_SESSION';

export async function buildServer(options: ServerOptions): Promise<MockApp> {
  const mock = createMockApp('keystone-idp-mock');
  const { app, log } = mock;
  const keys: SigningKeys = await createSigningKeys();
  const localJwks = createLocalJWKSet(keys.jwks);
  const issuer = options.issuer.replace(/\/$/, '');

  const transactions = new Map<string, Transaction>();
  const codes = new Map<string, Transaction>();
  const sessions = new Map<string, Session>();
  const refreshTokens = new Map<string, RefreshToken>();

  setInterval(() => {
    const now = Date.now();
    for (const [id, txn] of transactions) {
      if (now - txn.createdAt > TXN_TTL_MS) {
        transactions.delete(id);
      }
    }
    for (const [code, txn] of codes) {
      if (now - txn.createdAt > TXN_TTL_MS) {
        codes.delete(code);
      }
    }
  }, 60_000).unref();

  // ---------------------------------------------------------------- discovery and keys

  const discovery = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth2/v1/authorize`,
    token_endpoint: `${issuer}/oauth2/v1/token`,
    userinfo_endpoint: `${issuer}/oauth2/v1/userinfo`,
    jwks_uri: `${issuer}/oauth2/v1/keys`,
    end_session_endpoint: `${issuer}/oauth2/v1/logout`,
    revocation_endpoint: `${issuer}/oauth2/v1/revoke`,
    introspection_endpoint: `${issuer}/oauth2/v1/introspect`,
    check_session_iframe: `${issuer}/oauth2/v1/check-session`,
    response_types_supported: ['code', 'id_token', 'code id_token', 'id_token token'],
    response_modes_supported: ['query', 'fragment', 'form_post'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials', 'implicit'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'phone', 'offline_access', 'accounts.read',
      'payments.write', 'entitlements.read', 'treasury.read', 'treasury.approve'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'amr', 'acr', 'mfa_at', 'auth_time',
      'name', 'given_name', 'family_name', 'preferred_username', 'email', 'email_verified', 'phone_number',
      'meridian_segment', 'meridian_org'],
    code_challenge_methods_supported: ['S256', 'plain'],
    request_parameter_supported: false,
    claims_parameter_supported: false
  });

  app.get('/.well-known/openid-configuration', (_req, res) => res.json(discovery()));
  app.get('/oauth2/v1/.well-known/openid-configuration', (_req, res) => res.json(discovery()));
  app.get('/oauth2/v1/keys', (_req, res) => {
    res.setHeader('cache-control', 'public, max-age=300');
    res.json(keys.jwks);
  });
  app.get('/.well-known/jwks.json', (_req, res) => res.json(keys.jwks));

  // ---------------------------------------------------------------- helpers

  const issueTokens = async (client: OidcClient, user: KeystoneUser, scope: string[], amr: string[],
                             mfaAt: number, nonce?: string, authTime?: number) => {
    const accessToken = await sign(keys, {
      sub: user.sub,
      client_id: client.clientId,
      scope: scope.join(' '),
      scp: scope,
      preferred_username: user.username,
      amr,
      mfa_at: mfaAt,
      meridian_segment: user.segment,
      jti: randomUUID()
    }, issuer, API_AUDIENCE, client.accessTokenTtlSeconds);

    const idClaims: Record<string, unknown> = {
      sub: user.sub,
      nonce,
      auth_time: authTime || Math.floor(Date.now() / 1000),
      amr,
      acr: amr.includes('otp') ? 'urn:meridian:keystone:loa2' : 'urn:meridian:keystone:loa1',
      mfa_at: mfaAt,
      at_hash: atHash(accessToken),
      azp: client.clientId,
      meridian_segment: user.segment
    };
    if (scope.includes('profile')) {
      Object.assign(idClaims, {
        name: user.name,
        given_name: user.givenName,
        family_name: user.familyName,
        preferred_username: user.username,
        meridian_org: user.organisation
      });
    }
    if (scope.includes('email')) {
      Object.assign(idClaims, { email: user.email, email_verified: true });
    }
    if (scope.includes('phone')) {
      Object.assign(idClaims, { phone_number: user.phone, phone_number_verified: true });
    }
    const idToken = await sign(keys, idClaims, issuer, client.clientId, ID_TOKEN_TTL);

    let refreshToken: string | undefined;
    if (scope.includes('offline_access') || client.redirectUris.length > 0) {
      refreshToken = 'rt_' + randomBytes(32).toString('base64url');
      refreshTokens.set(refreshToken, { token: refreshToken, clientId: client.clientId, user, scope, amr, mfaAt, nonce });
      setTimeout(() => refreshTokens.delete(refreshToken as string), REFRESH_TTL_MS).unref();
    }

    return {
      token_type: 'Bearer',
      expires_in: client.accessTokenTtlSeconds,
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      scope: scope.join(' ')
    };
  };

  const redirectWithCode = (res: Response, txn: Transaction) => {
    const code = 'ac_' + randomBytes(24).toString('base64url');
    txn.code = code;
    codes.set(code, txn);
    transactions.delete(txn.id);
    const url = new URL(txn.redirectUri);
    const params = new URLSearchParams({ code });
    if (txn.state) {
      params.set('state', txn.state);
    }
    params.set('iss', issuer);
    if (txn.responseMode === 'fragment') {
      url.hash = params.toString();
    } else if (txn.responseMode === 'form_post') {
      res.type('html').send(`<!doctype html><html><body onload="document.forms[0].submit()">
<form method="post" action="${url.toString()}">${[...params].map(([k, v]) =>
  `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`).join('')}
<noscript><button>Continue</button></noscript></form></body></html>`);
      return;
    } else {
      for (const [k, v] of params) {
        url.searchParams.set(k, v);
      }
    }
    log.info({ event: 'oidc.code.issued', correlationId: res.locals.correlationId, clientId: txn.clientId, sub: txn.user?.sub, amr: txn.amr });
    res.redirect(302, url.toString());
  };

  const readCookie = (req: Request, name: string): string | undefined => {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) {
        return rest.join('=');
      }
    }
    return undefined;
  };

  const authenticateClient = (req: Request): { client?: OidcClient; error?: string } => {
    let clientId = req.body.client_id as string | undefined;
    let secret = req.body.client_secret as string | undefined;
    const header = req.headers.authorization;
    if (header && header.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      clientId = decodeURIComponent(decoded.slice(0, idx));
      secret = decodeURIComponent(decoded.slice(idx + 1));
    }
    if (!clientId) {
      return { error: 'client_id is required' };
    }
    const known = findClient(clientId);
    if (!known) {
      log.warn({ event: 'oidc.client.unknown', clientId });
      return { client: { clientId, name: clientId, redirectUris: ['*'], postLogoutRedirectUris: ['*'], scopes: [], accessTokenTtlSeconds: 900 } };
    }
    if (known.secret && known.secret !== secret) {
      return { error: 'invalid client secret' };
    }
    return { client: known };
  };

  const oauthError = (res: Response, status: number, error: string, description: string) => {
    res.status(status).json({ error, error_description: description });
  };

  // ---------------------------------------------------------------- authorize

  app.get('/oauth2/v1/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    const clientId = q.client_id;
    const redirectUri = q.redirect_uri;
    if (!clientId || !redirectUri) {
      res.status(400).type('html').send(errorPage('Bad request', 'client_id and redirect_uri are required.'));
      return;
    }
    const client = findClient(clientId);
    if (!client) {
      log.warn({ event: 'oidc.client.unknown', clientId, redirectUri });
    } else if (!client.redirectUris.some((u) => u === redirectUri || u === '*')) {
      // Registered clients get the real behaviour. An unregistered redirect is the single most
      // common Keystone integration fault, so the message is explicit.
      res.status(400).type('html').send(errorPage('Redirect URI not registered',
        `${redirectUri} is not registered for ${clientId}. Registered: ${client.redirectUris.join(', ')}`));
      return;
    }
    if (q.response_type !== 'code') {
      res.status(400).type('html').send(errorPage('Unsupported response_type',
        'Keystone only issues authorization codes since the implicit flow was retired (GIS-2210, 2023-04).'));
      return;
    }
    if (client && !client.secret && !q.code_challenge) {
      res.status(400).type('html').send(errorPage('PKCE required',
        'Public clients must send code_challenge. See the Keystone integration standard, section 4.2.'));
      return;
    }

    const txn: Transaction = {
      id: randomBytes(16).toString('hex'),
      clientId,
      redirectUri,
      scope: (q.scope || 'openid').split(/[\s+]+/).filter(Boolean),
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      codeChallengeMethod: q.code_challenge_method || (q.code_challenge ? 'plain' : undefined),
      responseMode: q.response_mode,
      amr: [],
      createdAt: Date.now()
    };
    transactions.set(txn.id, txn);

    // Single sign on: an existing browser session skips the pages unless the RP asks otherwise.
    const sessionId = readCookie(req, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    const forceLogin = q.prompt === 'login' || q.max_age === '0';
    const wantsStepUp = (q.acr_values || '').includes('loa2') || q.prompt === 'login';
    if (session && !forceLogin) {
      txn.user = session.user;
      txn.amr = session.amr;
      txn.passwordAt = session.createdAt;
      txn.mfaAt = session.mfaAt;
      const mfaAgeSeconds = Math.floor(Date.now() / 1000) - session.mfaAt;
      if (wantsStepUp && mfaAgeSeconds > 600) {
        res.type('html').send(mfaPage(txn.id, maskPhone(session.user.phone)));
        return;
      }
      redirectWithCode(res, txn);
      return;
    }
    if (q.prompt === 'none') {
      const url = new URL(redirectUri);
      url.searchParams.set('error', 'login_required');
      if (q.state) {
        url.searchParams.set('state', q.state);
      }
      res.redirect(302, url.toString());
      return;
    }
    res.type('html').send(loginPage(txn.id));
  });

  app.post('/login', (req, res) => {
    const { txn: txnId, username, password } = req.body as Record<string, string>;
    const txn = transactions.get(txnId);
    if (!txn) {
      res.status(400).type('html').send(errorPage('Session expired', 'Start again from the application.'));
      return;
    }
    const user = username ? findUser(username) : undefined;
    if (!user || password !== PASSWORD) {
      log.warn({ event: 'auth.password.failed', correlationId: res.locals.correlationId, username });
      res.status(401).type('html').send(loginPage(txn.id, 'We could not sign you in with those details.'));
      return;
    }
    txn.user = user;
    txn.passwordAt = Math.floor(Date.now() / 1000);
    txn.amr = ['pwd'];
    log.info({ event: 'auth.password.ok', correlationId: res.locals.correlationId, sub: user.sub });
    res.redirect(303, `/mfa?txn=${encodeURIComponent(txn.id)}`);
  });

  app.get('/mfa', (req, res) => {
    const txn = transactions.get(String(req.query.txn || ''));
    if (!txn || !txn.user) {
      res.status(400).type('html').send(errorPage('Session expired', 'Start again from the application.'));
      return;
    }
    res.type('html').send(mfaPage(txn.id, maskPhone(txn.user.phone)));
  });

  app.post('/mfa', (req, res) => {
    const { txn: txnId, code } = req.body as Record<string, string>;
    const txn = transactions.get(txnId);
    if (!txn || !txn.user) {
      res.status(400).type('html').send(errorPage('Session expired', 'Start again from the application.'));
      return;
    }
    if (code !== MFA_CODE) {
      log.warn({ event: 'auth.mfa.failed', correlationId: res.locals.correlationId, sub: txn.user.sub });
      res.status(401).type('html').send(mfaPage(txn.id, maskPhone(txn.user.phone), 'That code did not match. Try again.'));
      return;
    }
    txn.mfaAt = Math.floor(Date.now() / 1000);
    txn.amr = Array.from(new Set([...txn.amr, 'pwd', 'otp', 'mfa']));
    const session: Session = {
      id: randomBytes(24).toString('base64url'),
      user: txn.user,
      amr: txn.amr,
      mfaAt: txn.mfaAt,
      createdAt: txn.passwordAt || txn.mfaAt
    };
    sessions.set(session.id, session);
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${session.id}; Path=/; HttpOnly; SameSite=Lax`);
    log.info({ event: 'auth.mfa.ok', correlationId: res.locals.correlationId, sub: txn.user.sub });
    redirectWithCode(res, txn);
  });

  // ---------------------------------------------------------------- token

  app.post('/oauth2/v1/token', async (req, res) => {
    const grant = req.body.grant_type as string | undefined;
    const auth = authenticateClient(req);
    if (!auth.client) {
      oauthError(res, 401, 'invalid_client', auth.error || 'client authentication failed');
      return;
    }
    const client = auth.client;

    if (grant === 'authorization_code') {
      const txn = codes.get(String(req.body.code || ''));
      if (!txn || !txn.user) {
        oauthError(res, 400, 'invalid_grant', 'authorization code is unknown or already used');
        return;
      }
      codes.delete(txn.code as string);
      if (txn.clientId !== client.clientId) {
        oauthError(res, 400, 'invalid_grant', 'code was issued to a different client');
        return;
      }
      if (req.body.redirect_uri && req.body.redirect_uri !== txn.redirectUri) {
        oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
        return;
      }
      if (txn.codeChallenge) {
        const verifier = req.body.code_verifier as string | undefined;
        if (!verifier) {
          oauthError(res, 400, 'invalid_grant', 'code_verifier is required');
          return;
        }
        const expected = txn.codeChallengeMethod === 'S256' ? s256(verifier) : verifier;
        if (expected !== txn.codeChallenge) {
          log.warn({ event: 'oidc.pkce.mismatch', correlationId: res.locals.correlationId, clientId: client.clientId });
          oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
          return;
        }
      }
      const tokens = await issueTokens(client, txn.user, txn.scope, txn.amr, txn.mfaAt || 0, txn.nonce, txn.passwordAt);
      res.setHeader('cache-control', 'no-store');
      res.json(tokens);
      return;
    }

    if (grant === 'refresh_token') {
      const stored = refreshTokens.get(String(req.body.refresh_token || ''));
      if (!stored || stored.clientId !== client.clientId) {
        oauthError(res, 400, 'invalid_grant', 'refresh token is unknown, expired or revoked');
        return;
      }
      refreshTokens.delete(stored.token);
      const tokens = await issueTokens(client, stored.user, stored.scope, stored.amr, stored.mfaAt, stored.nonce);
      res.setHeader('cache-control', 'no-store');
      res.json(tokens);
      return;
    }

    if (grant === 'client_credentials') {
      if (!client.secret) {
        oauthError(res, 400, 'unauthorized_client', 'public clients cannot use client_credentials');
        return;
      }
      const scope = String(req.body.scope || client.scopes.join(' ')).split(/\s+/).filter(Boolean);
      const accessToken = await sign(keys, {
        sub: client.clientId,
        client_id: client.clientId,
        scope: scope.join(' '),
        scp: scope,
        amr: ['client'],
        jti: randomUUID()
      }, issuer, API_AUDIENCE, client.accessTokenTtlSeconds);
      res.setHeader('cache-control', 'no-store');
      res.json({ token_type: 'Bearer', expires_in: client.accessTokenTtlSeconds, access_token: accessToken, scope: scope.join(' ') });
      return;
    }

    // Password grant is retired in Keystone proper (GIS-2210) but the smoke harness and the
    // Iris orchestrator's contract tests still lean on it. Kept behind a flag.
    if (grant === 'password' && process.env.KEYSTONE_ALLOW_PASSWORD_GRANT === 'true') {
      const user = findUser(String(req.body.username || ''));
      if (!user || req.body.password !== PASSWORD) {
        oauthError(res, 400, 'invalid_grant', 'bad credentials');
        return;
      }
      const scope = String(req.body.scope || 'openid profile email').split(/\s+/).filter(Boolean);
      const now = Math.floor(Date.now() / 1000);
      res.json(await issueTokens(client, user, scope, ['pwd', 'otp'], now, undefined, now));
      return;
    }

    oauthError(res, 400, 'unsupported_grant_type', `grant_type ${grant} is not supported`);
  });

  // ---------------------------------------------------------------- userinfo, introspect, revoke, logout

  const bearer = (req: Request): string | undefined => {
    const h = req.headers.authorization || '';
    return h.toLowerCase().startsWith('bearer ') ? h.slice(7) : undefined;
  };

  app.get('/oauth2/v1/userinfo', async (req, res) => {
    const token = bearer(req);
    if (!token) {
      res.setHeader('www-authenticate', 'Bearer realm="keystone"');
      sendError(res, 401, 'UNAUTHENTICATED', 'bearer token required');
      return;
    }
    try {
      const { payload } = await jwtVerify(token, localJwks, { issuer });
      const user = findUser(String(payload.sub));
      if (!user) {
        sendError(res, 404, 'UNKNOWN_SUBJECT', 'subject not found');
        return;
      }
      res.json({
        sub: user.sub,
        name: user.name,
        given_name: user.givenName,
        family_name: user.familyName,
        preferred_username: user.username,
        email: user.email,
        email_verified: true,
        phone_number: user.phone,
        meridian_segment: user.segment,
        meridian_org: user.organisation,
        amr: payload.amr,
        mfa_at: payload.mfa_at
      });
    } catch (err) {
      sendError(res, 401, 'INVALID_TOKEN', (err as Error).message);
    }
  });

  app.post('/oauth2/v1/introspect', async (req, res) => {
    const token = String(req.body.token || '');
    try {
      const { payload } = await jwtVerify(token, localJwks, { issuer });
      res.json({ active: true, ...payload });
    } catch {
      res.json({ active: false });
    }
  });

  app.post('/oauth2/v1/revoke', (req, res) => {
    refreshTokens.delete(String(req.body.token || ''));
    res.status(200).end();
  });

  app.get('/oauth2/v1/logout', (req, res) => {
    const sessionId = readCookie(req, SESSION_COOKIE);
    if (sessionId) {
      sessions.delete(sessionId);
    }
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    const target = req.query.post_logout_redirect_uri as string | undefined;
    if (target) {
      const url = new URL(target);
      if (req.query.state) {
        url.searchParams.set('state', String(req.query.state));
      }
      res.redirect(302, url.toString());
      return;
    }
    res.type('html').send(loggedOutPage());
  });

  app.get('/oauth2/v1/check-session', (_req, res) => {
    res.type('html').send('<!doctype html><html><body><script>/* session management is not implemented in the mock */</script></body></html>');
  });

  // ---------------------------------------------------------------- SAML stub

  app.get('/saml/metadata', (_req, res) => {
    res.type('application/xml').send(samlMetadata(issuer, keys));
  });
  app.all('/saml/sso', async (req, res) => {
    const relayState = String(req.body?.RelayState || req.query.RelayState || '');
    const acs = String(req.body?.acs || req.query.acs || 'http://localhost:4210/saml/acs');
    const nameId = String(req.body?.nameId || req.query.nameId || 'wealth.portal.test');
    res.type('html').send(await samlResponsePage(issuer, keys, acs, nameId, relayState));
  });

  // ---------------------------------------------------------------- debug surface

  app.get('/debug/users', (_req, res) => {
    res.json(allUsers().map((u) => ({ username: u.username, email: u.email, sub: u.sub, segment: u.segment, name: u.name })));
  });
  app.get('/debug/sessions', (_req, res) => {
    res.json([...sessions.values()].map((s) => ({ sub: s.user.sub, amr: s.amr, mfaAt: s.mfaAt })));
  });
  app.get('/', (_req, res) => {
    res.type('html').send(errorPage('Keystone IdP mock', `Discovery at ${issuer}/.well-known/openid-configuration`));
  });

  return mock;
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `(***) ***-${digits.slice(-4)}`;
}
