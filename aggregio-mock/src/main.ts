import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer().listen(envPort('AGGREGIO_PORT', 4601)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'aggregio-mock', error: String(err) }));
  process.exit(1);
});
