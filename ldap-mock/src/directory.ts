import { stableHash } from '@meridian/mock-kit';

/**
 * The staff directory. In the bank this is Active Directory (MERIDIAN\ domain) fronted by a
 * read-only LDAP proxy; here it is a list. Handles are the ones in the git history roster so
 * `git log` authors and directory users line up when somebody greps for a name in the demo.
 *
 * Base DN: dc=meridiantrust,dc=example
 *   ou=staff             people, uid=<handle>
 *   ou=service-accounts  cn=svc-<service>
 *   ou=groups            cn=<group>, groupOfNames with member DNs
 *
 * Password for every staff account is Passw0rd (same as Keystone, on purpose). Service
 * accounts use CHANGEME-ldap-bind.
 */

export const BASE_DN = 'dc=meridiantrust,dc=example';
export const STAFF_OU = `ou=staff,${BASE_DN}`;
export const SERVICE_OU = `ou=service-accounts,${BASE_DN}`;
export const GROUPS_OU = `ou=groups,${BASE_DN}`;
export const STAFF_PASSWORD = 'Passw0rd';
export const SERVICE_PASSWORD = 'CHANGEME-ldap-bind';

export interface Entry {
  dn: string;
  attributes: Record<string, string | string[]>;
}

interface Person {
  uid: string;
  cn: string;
  sn: string;
  givenName: string;
  title: string;
  department: string;
  site: string;
  groups: string[];
}

const PEOPLE: Person[] = [
  { uid: 'd.okafor', cn: 'Deborah Okafor', sn: 'Okafor', givenName: 'Deborah', title: 'Staff Engineer', department: 'Retail Digital', site: 'Charlotte', groups: ['digital-engineers', 'beacon-admins'] },
  { uid: 'm.calderon', cn: 'Miguel Calderon', sn: 'Calderon', givenName: 'Miguel', title: 'Senior Engineer', department: 'Retail Digital', site: 'Charlotte', groups: ['digital-engineers'] },
  { uid: 's.whitfield', cn: 'Sarah Whitfield', sn: 'Whitfield', givenName: 'Sarah', title: 'Principal Engineer', department: 'Canopy Design System', site: 'Charlotte', groups: ['digital-engineers', 'release-managers'] },
  { uid: 't.nakamura', cn: 'Tomoko Nakamura', sn: 'Nakamura', givenName: 'Tomoko', title: 'Senior Engineer', department: 'Treasury Digital', site: 'Jersey City', groups: ['digital-engineers'] },
  { uid: 'j.hollins', cn: 'Jared Hollins', sn: 'Hollins', givenName: 'Jared', title: 'Lead Engineer', department: 'Payments Platform', site: 'Jersey City', groups: ['digital-engineers', 'beacon-admins', 'platform-oncall'] },
  { uid: 'p.venkatesan', cn: 'Priya Venkatesan', sn: 'Venkatesan', givenName: 'Priya', title: 'Senior Engineer', department: 'Payments Platform', site: 'Chennai', groups: ['digital-engineers', 'platform-oncall'] },
  { uid: 'a.balaraman', cn: 'Arun Balaraman', sn: 'Balaraman', givenName: 'Arun', title: 'Staff Engineer', department: 'Platform Engineering', site: 'Chennai', groups: ['digital-engineers', 'beacon-admins', 'platform-oncall'] },
  { uid: 'k.subramani', cn: 'Kavitha Subramani', sn: 'Subramani', givenName: 'Kavitha', title: 'Engineer II', department: 'Business Digital', site: 'Chennai', groups: ['digital-engineers'] },
  { uid: 'g.mwangi', cn: 'Grace Mwangi', sn: 'Mwangi', givenName: 'Grace', title: 'Lead Engineer', department: 'Identity Platform', site: 'Chester', groups: ['digital-engineers', 'release-managers'] },
  { uid: 'o.lindqvist', cn: 'Oskar Lindqvist', sn: 'Lindqvist', givenName: 'Oskar', title: 'Senior Engineer', department: 'Identity Platform', site: 'Chester', groups: ['digital-engineers'] },
  { uid: 'c.mbeki', cn: 'Chidi Mbeki', sn: 'Mbeki', givenName: 'Chidi', title: 'Security Engineer', department: 'Global Information Security', site: 'Charlotte', groups: ['gis-reviewers', 'digital-engineers'] },
  { uid: 'v.orlova', cn: 'Valeria Orlova', sn: 'Orlova', givenName: 'Valeria', title: 'Senior Security Analyst', department: 'Global Information Security', site: 'Jersey City', groups: ['gis-reviewers'] },
  { uid: 'e.castellanos', cn: 'Elena Castellanos', sn: 'Castellanos', givenName: 'Elena', title: 'Principal Engineer', department: 'Platform Engineering', site: 'Plano', groups: ['digital-engineers', 'release-managers', 'platform-oncall'] },
  { uid: 'f.adeyemi', cn: 'Femi Adeyemi', sn: 'Adeyemi', givenName: 'Femi', title: 'Senior Engineer', department: 'Digital Analytics Enablement', site: 'Chester', groups: ['digital-engineers'] },
  { uid: 'w.tanaka', cn: 'Wataru Tanaka', sn: 'Tanaka', givenName: 'Wataru', title: 'Enterprise Architect', department: 'CSWT Architecture', site: 'Plano', groups: ['digital-engineers'] },
  { uid: 'ops.petrova', cn: 'Galina Petrova', sn: 'Petrova', givenName: 'Galina', title: 'Operations Lead', department: 'Contact Centre Technology', site: 'Plano', groups: ['beacon-operators'] }
];

const SERVICE_ACCOUNTS = ['svc-beacon', 'svc-alerts-preferences', 'svc-audit-trail', 'svc-entitlements', 'svc-jenkins', 'svc-sonar'];

const GROUPS: Record<string, string> = {
  'beacon-admins': 'Beacon notifications console administrators. Can pause channels and replay dead letters.',
  'gis-reviewers': 'Global Information Security reviewers. Required approver on security sensitive paths.',
  'digital-engineers': 'All digital engineering staff.',
  'platform-oncall': 'Platform services on call rota.',
  'release-managers': 'Release train coordinators.',
  'beacon-operators': 'Read only Beacon console access for the contact centre.'
};

export function buildDirectory(): Entry[] {
  const entries: Entry[] = [
    { dn: BASE_DN, attributes: { objectClass: ['top', 'dcObject', 'organization'], dc: 'meridiantrust', o: 'Meridian Trust Bank' } },
    { dn: STAFF_OU, attributes: { objectClass: ['top', 'organizationalUnit'], ou: 'staff' } },
    { dn: SERVICE_OU, attributes: { objectClass: ['top', 'organizationalUnit'], ou: 'service-accounts' } },
    { dn: GROUPS_OU, attributes: { objectClass: ['top', 'organizationalUnit'], ou: 'groups' } }
  ];

  for (const p of PEOPLE) {
    entries.push({
      dn: `uid=${p.uid},${STAFF_OU}`,
      attributes: {
        objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
        uid: p.uid, cn: p.cn, sn: p.sn, givenName: p.givenName,
        mail: `${p.uid}@meridiantrust.example`,
        title: p.title, departmentNumber: p.department, l: p.site,
        employeeNumber: String(100000 + (stableHash(p.uid) % 900000)),
        sAMAccountName: p.uid,
        memberOf: p.groups.map((g) => `cn=${g},${GROUPS_OU}`)
      }
    });
  }

  for (const svc of SERVICE_ACCOUNTS) {
    entries.push({
      dn: `cn=${svc},${SERVICE_OU}`,
      attributes: { objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'], cn: svc, sn: svc, uid: svc, description: `Service account for ${svc.slice(4)}` }
    });
  }

  for (const [name, description] of Object.entries(GROUPS)) {
    const members = PEOPLE.filter((p) => p.groups.includes(name)).map((p) => `uid=${p.uid},${STAFF_OU}`);
    entries.push({
      dn: `cn=${name},${GROUPS_OU}`,
      attributes: { objectClass: ['top', 'groupOfNames'], cn: name, description, member: members.length > 0 ? members : [`cn=svc-beacon,${SERVICE_OU}`] }
    });
  }

  return entries;
}

export function normaliseDn(dn: string): string {
  return dn.split(',').map((p) => p.trim().replace(/\s*=\s*/, '=').toLowerCase()).join(',');
}

export function passwordFor(dn: string): string | undefined {
  const n = normaliseDn(dn);
  if (n.endsWith(normaliseDn(STAFF_OU))) return STAFF_PASSWORD;
  if (n.endsWith(normaliseDn(SERVICE_OU))) return SERVICE_PASSWORD;
  return undefined;
}
