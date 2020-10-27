import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

const port = envPort('KEYSTONE_IDP_PORT', 4400);
// The issuer has to match what the relying parties have in their env.json byte for byte, so it
// is fixed to localhost even inside compose. Containers reach it through host networking.
const issuer = process.env.KEYSTONE_ISSUER || `http://localhost:${port}`;

buildServer({ issuer })
  .then((mock) => mock.listen(port))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: 'service.failed', service: 'keystone-idp-mock', error: String(err) }));
    process.exit(1);
  });
