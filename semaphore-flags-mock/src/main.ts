import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer().listen(envPort('SEMAPHORE_PORT', 4608)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'semaphore-flags-mock', error: String(err) }));
  process.exit(1);
});
