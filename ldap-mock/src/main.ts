import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

const mock = buildServer();
mock.listenLdap(envPort('LDAP_PORT', 4609))
  .then(() => mock.listen(envPort('LDAP_HTTP_PORT', 14609)))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: 'service.failed', service: 'ldap-mock', error: String(err) }));
    process.exit(1);
  });
