import { createHash } from 'crypto';
import { exportJWK, generateKeyPair, JWK, KeyLike, SignJWT } from 'jose';

/**
 * Signing material. A fresh RSA pair per process start. The real Keystone rotates through two
 * kids (current and previous) every ninety days, so the JWKS always carries two keys and the
 * relying parties are expected to pick by kid. We do the same: the previous key is a second
 * random pair that never signs anything, which is enough to catch clients that only ever read
 * keys[0].
 */
export interface SigningKeys {
  kid: string;
  privateKey: KeyLike;
  jwks: { keys: JWK[] };
}

export async function createSigningKeys(): Promise<SigningKeys> {
  const current = await generateKeyPair('RS256', { modulusLength: 2048 });
  const previous = await generateKeyPair('RS256', { modulusLength: 2048 });
  const kid = 'keystone-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-a';
  const prevKid = 'keystone-rotated-out';
  const cur = await exportJWK(current.publicKey);
  const prev = await exportJWK(previous.publicKey);
  return {
    kid,
    privateKey: current.privateKey,
    jwks: {
      keys: [
        { ...cur, kid, use: 'sig', alg: 'RS256' },
        { ...prev, kid: prevKid, use: 'sig', alg: 'RS256' }
      ]
    }
  };
}

export async function sign(keys: SigningKeys, claims: Record<string, unknown>,
                           issuer: string, audience: string | string[], ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(keys.privateKey);
}

/** Left half of SHA-256, base64url. Required by angular-oauth2-oidc unless disableAtHashCheck. */
export function atHash(accessToken: string): string {
  const digest = createHash('sha256').update(accessToken).digest();
  return digest.subarray(0, digest.length / 2).toString('base64url');
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
