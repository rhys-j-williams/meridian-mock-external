import { Customer } from '@meridian/domain-fixtures';
import { fixtures } from '@meridian/mock-kit';

/**
 * Every fixture customer is a Keystone user. The username is the local part of the fixture
 * email, which is what the real Keystone does for consumers enrolled before the 2021 username
 * policy change. Staff accounts (Beacon admins) come from ldap-mock, not from here.
 */
export interface KeystoneUser {
  sub: string;
  username: string;
  email: string;
  name: string;
  givenName: string;
  familyName: string;
  phone: string;
  segment: Customer['segment'];
  organisation?: string;
}

export const PASSWORD = 'Passw0rd';
export const MFA_CODE = '123456';

let table: Map<string, KeystoneUser> | undefined;

function build(): Map<string, KeystoneUser> {
  const map = new Map<string, KeystoneUser>();
  for (const c of fixtures().customers) {
    const user: KeystoneUser = {
      sub: c.customerId,
      username: c.email.split('@')[0].toLowerCase(),
      email: c.email,
      name: c.displayName,
      givenName: c.firstName,
      familyName: c.lastName,
      phone: c.mobile,
      segment: c.segment,
      organisation: c.organisationName
    };
    map.set(user.username, user);
    map.set(user.email.toLowerCase(), user);
    map.set(user.sub, user);
  }
  return map;
}

export function findUser(identifier: string): KeystoneUser | undefined {
  if (!table) {
    table = build();
  }
  return table.get(identifier.trim().toLowerCase()) || table.get(identifier.trim());
}

export function allUsers(): KeystoneUser[] {
  if (!table) {
    table = build();
  }
  const seen = new Set<string>();
  const out: KeystoneUser[] = [];
  for (const u of table.values()) {
    if (!seen.has(u.sub)) {
      seen.add(u.sub);
      out.push(u);
    }
  }
  return out;
}
