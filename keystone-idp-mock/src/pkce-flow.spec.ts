import { randomBytes } from 'crypto';
import * as http from 'http';
import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';
import { s256 } from './keys';
import { buildServer } from './server';

/**
 * Drives the whole authorization code + PKCE flow the way angular-oauth2-oidc does, then
 * validates the ID token against the JWKS endpoint the way bff-retail's JwtStrategy does.
 * If this test is green the estate can log in.
 */

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method || 'GET', headers: init.headers
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('keystone-idp-mock authorization code flow', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const mock = await buildServer({ issuer: 'http://localhost:0' });
    server = await new Promise<http.Server>((resolve) => {
      const s = mock.app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    base = `http://localhost:${port}`;
    // the mock was built with a placeholder issuer; rebuild with the real port so discovery matches
    server.close();
    const real = await buildServer({ issuer: base });
    server = await new Promise<http.Server>((resolve) => {
      const s = real.app.listen(port, () => resolve(s));
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('publishes a discovery document whose endpoints sit under the issuer', async () => {
    const res = await request(`${base}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.issuer).toBe(base);
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'userinfo_endpoint', 'end_session_endpoint']) {
      expect(doc[key].startsWith(base)).toBe(true);
    }
    expect(doc.code_challenge_methods_supported).toContain('S256');
  });

  it('completes password, MFA and PKCE and issues tokens that verify against the JWKS', async () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = s256(verifier);
    const state = 'st-' + randomBytes(4).toString('hex');
    const nonce = 'n-' + randomBytes(4).toString('hex');

    const users = JSON.parse((await request(`${base}/debug/users`)).body) as { username: string; sub: string }[];
    expect(users.length).toBeGreaterThan(5);
    const user = users[3];

    const authorize = await request(`${base}/oauth2/v1/authorize?` + form({
      client_id: 'meridian-online-web',
      redirect_uri: 'http://localhost:4200/index.html',
      response_type: 'code',
      scope: 'openid profile email offline_access accounts.read',
      state, nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }));
    expect(authorize.status).toBe(200);
    const txn = /name="txn" value="([^"]+)"/.exec(authorize.body)?.[1];
    expect(txn).toBeDefined();

    const wrongPassword = await request(`${base}/login`, { method: 'POST', headers: FORM, body: form({ txn: txn as string, username: user.username, password: 'nope' }) });
    expect(wrongPassword.status).toBe(401);

    const login = await request(`${base}/login`, { method: 'POST', headers: FORM, body: form({ txn: txn as string, username: user.username, password: 'Passw0rd' }) });
    expect(login.status).toBe(303);
    expect(login.headers.location).toContain('/mfa');

    const badCode = await request(`${base}/mfa`, { method: 'POST', headers: FORM, body: form({ txn: txn as string, code: '000000' }) });
    expect(badCode.status).toBe(401);

    const mfa = await request(`${base}/mfa`, { method: 'POST', headers: FORM, body: form({ txn: txn as string, code: '123456' }) });
    expect(mfa.status).toBe(302);
    const redirect = new URL(mfa.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe('http://localhost:4200/index.html');
    expect(redirect.searchParams.get('state')).toBe(state);
    const code = redirect.searchParams.get('code') as string;
    expect(code).toMatch(/^ac_/);
    expect(mfa.headers['set-cookie']?.[0]).toContain('KEYSTONE_SESSION=');

    const badVerifier = await request(`${base}/oauth2/v1/token`, { method: 'POST', headers: FORM, body: form({
      grant_type: 'authorization_code', client_id: 'meridian-online-web', code, code_verifier: 'wrong', redirect_uri: 'http://localhost:4200/index.html'
    }) });
    // a failed PKCE check burns the code, exactly as the real Keystone does
    expect(badVerifier.status).toBe(400);
    expect(JSON.parse(badVerifier.body).error).toBe('invalid_grant');

    // run the flow again against the SSO cookie: no pages this time
    const cookie = (mfa.headers['set-cookie'] as string[])[0].split(';')[0];
    const sso = await request(`${base}/oauth2/v1/authorize?` + form({
      client_id: 'meridian-online-web', redirect_uri: 'http://localhost:4200/index.html', response_type: 'code',
      scope: 'openid profile email offline_access accounts.read', state, nonce, code_challenge: challenge, code_challenge_method: 'S256'
    }), { headers: { cookie } });
    expect(sso.status).toBe(302);
    const code2 = new URL(sso.headers.location as string).searchParams.get('code') as string;

    const token = await request(`${base}/oauth2/v1/token`, { method: 'POST', headers: FORM, body: form({
      grant_type: 'authorization_code', client_id: 'meridian-online-web', code: code2, code_verifier: verifier, redirect_uri: 'http://localhost:4200/index.html'
    }) });
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.body);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.refresh_token).toMatch(/^rt_/);

    const jwks = createRemoteJWKSet(new URL(`${base}/oauth2/v1/keys`));
    const id = await jwtVerify(tokens.id_token, jwks, { issuer: base, audience: 'meridian-online-web' });
    expect(id.payload.sub).toBe(user.sub);
    expect(id.payload.nonce).toBe(nonce);
    expect(id.payload.amr).toEqual(expect.arrayContaining(['pwd', 'otp']));
    expect(typeof id.payload.mfa_at).toBe('number');
    expect(id.protectedHeader.kid).toMatch(/^keystone-/);
    expect(id.payload.email).toMatch(/@example\.com$/);

    const access = await jwtVerify(tokens.access_token, jwks, { issuer: base, audience: 'api://meridian-digital-channels' });
    expect(access.payload.scope).toContain('accounts.read');
    expect(decodeJwt(tokens.access_token).client_id).toBe('meridian-online-web');

    const userinfo = await request(`${base}/oauth2/v1/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(userinfo.status).toBe(200);
    expect(JSON.parse(userinfo.body).preferred_username).toBe(user.username);

    const refreshed = await request(`${base}/oauth2/v1/token`, { method: 'POST', headers: FORM, body: form({
      grant_type: 'refresh_token', client_id: 'meridian-online-web', refresh_token: tokens.refresh_token
    }) });
    expect(refreshed.status).toBe(200);
    expect(JSON.parse(refreshed.body).refresh_token).not.toBe(tokens.refresh_token);
  });

  it('issues service tokens through client_credentials with the client secret', async () => {
    const basic = Buffer.from('bff-retail:CHANGEME-bff-retail-client-secret').toString('base64');
    const res = await request(`${base}/oauth2/v1/token`, {
      method: 'POST', headers: { ...FORM, authorization: `Basic ${basic}` },
      body: form({ grant_type: 'client_credentials', scope: 'bedrock.read' })
    });
    expect(res.status).toBe(200);
    expect(decodeJwt(JSON.parse(res.body).access_token).amr).toEqual(['client']);

    const wrong = await request(`${base}/oauth2/v1/token`, { method: 'POST', headers: FORM, body: form({
      grant_type: 'client_credentials', client_id: 'bff-retail', client_secret: 'CHANGEME-wrong'
    }) });
    expect(wrong.status).toBe(401);
  });

  it('refuses public clients that skip PKCE and unregistered redirects', async () => {
    const noPkce = await request(`${base}/oauth2/v1/authorize?` + form({
      client_id: 'meridian-online-web', redirect_uri: 'http://localhost:4200/', response_type: 'code', scope: 'openid'
    }));
    expect(noPkce.status).toBe(400);
    expect(noPkce.body).toContain('PKCE required');

    const badRedirect = await request(`${base}/oauth2/v1/authorize?` + form({
      client_id: 'meridian-online-web', redirect_uri: 'http://evil.example/', response_type: 'code', scope: 'openid', code_challenge: 'x'
    }));
    expect(badRedirect.status).toBe(400);
  });

  it('serves the SAML stub', async () => {
    const meta = await request(`${base}/saml/metadata`);
    expect(meta.status).toBe(200);
    expect(meta.body).toContain('EntityDescriptor');
    const sso = await request(`${base}/saml/sso?RelayState=abc`);
    expect(sso.status).toBe(200);
    expect(sso.body).toContain('SAMLResponse');
  });
});
