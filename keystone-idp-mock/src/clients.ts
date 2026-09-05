/**
 * Relying parties. Mirrors the Keystone client registry export from 2024-06 with hostnames
 * rewritten to the local ports in PORTS.md. Unknown client ids are still served, with a warning,
 * because every new front end spike would otherwise start by editing this file.
 */
export interface OidcClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  /** Confidential clients present a secret at the token endpoint. Public ones use PKCE only. */
  secret?: string;
  scopes: string[];
  accessTokenTtlSeconds: number;
}

export const CLIENTS: OidcClient[] = [
  {
    clientId: 'meridian-online-web',
    name: 'Meridian Online (retail-web)',
    redirectUris: ['http://localhost:4200/', 'http://localhost:4200/index.html', 'http://localhost:4200/auth/callback', 'http://localhost:4200/silent-refresh.html'],
    postLogoutRedirectUris: ['http://localhost:4200/'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'accounts.read', 'payments.write'],
    accessTokenTtlSeconds: 900
  },
  {
    clientId: 'meridian-business-web',
    name: 'Meridian Business (business-web)',
    redirectUris: ['http://localhost:4201/', 'http://localhost:4201/index.html', 'http://localhost:4201/auth/callback', 'http://localhost:4201/silent-refresh.html'],
    postLogoutRedirectUris: ['http://localhost:4201/'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'accounts.read', 'payments.write', 'entitlements.read'],
    accessTokenTtlSeconds: 900
  },
  {
    clientId: 'keystone-web',
    name: 'Keystone login front end',
    redirectUris: ['http://localhost:4202/', 'http://localhost:4202/index.html', 'http://localhost:4202/callback'],
    postLogoutRedirectUris: ['http://localhost:4202/'],
    scopes: ['openid', 'profile', 'email'],
    accessTokenTtlSeconds: 600
  },
  {
    clientId: 'ledgerline-web',
    name: 'Ledgerline treasury (ledgerline-web)',
    redirectUris: ['http://localhost:4203/', 'http://localhost:4203/index.html', 'http://localhost:4203/auth/callback'],
    postLogoutRedirectUris: ['http://localhost:4203/'],
    scopes: ['openid', 'profile', 'email', 'offline_access', 'treasury.read', 'treasury.approve'],
    accessTokenTtlSeconds: 900
  },
  {
    clientId: 'canopy-showcase',
    name: 'Canopy showcase',
    redirectUris: ['http://localhost:4204/'],
    postLogoutRedirectUris: ['http://localhost:4204/'],
    scopes: ['openid', 'profile'],
    accessTokenTtlSeconds: 900
  },
  {
    clientId: 'bff-retail',
    name: 'Retail BFF service account',
    redirectUris: [],
    postLogoutRedirectUris: [],
    secret: 'CHANGEME-bff-retail-client-secret',
    scopes: ['accounts.read', 'bedrock.read'],
    accessTokenTtlSeconds: 1800
  },
  {
    clientId: 'bff-business',
    name: 'Business BFF service account',
    redirectUris: [],
    postLogoutRedirectUris: [],
    secret: 'CHANGEME-bff-business-client-secret',
    scopes: ['accounts.read', 'entitlements.read'],
    accessTokenTtlSeconds: 1800
  },
  {
    clientId: 'iris-orchestrator',
    name: 'Iris orchestrator service account',
    redirectUris: [],
    postLogoutRedirectUris: [],
    secret: 'CHANGEME-iris-orchestrator-client-secret',
    scopes: ['accounts.read'],
    accessTokenTtlSeconds: 1800
  },
  {
    clientId: 'estate-smoke',
    name: 'estate smoke test harness',
    redirectUris: ['http://localhost:9/callback', 'http://localhost/callback'],
    postLogoutRedirectUris: [],
    scopes: ['openid', 'profile', 'email', 'accounts.read'],
    accessTokenTtlSeconds: 300
  }
];

export function findClient(clientId: string): OidcClient | undefined {
  return CLIENTS.find((c) => c.clientId === clientId);
}

/** The API audience every resource server checks. Keystone calls it the "digital channels" API. */
export const API_AUDIENCE = 'api://meridian-digital-channels';
