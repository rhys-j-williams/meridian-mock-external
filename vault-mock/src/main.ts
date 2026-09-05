import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer().listen(envPort('VAULT_PORT', 4605)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'vault-mock', error: String(err) }));
  process.exit(1);
});
