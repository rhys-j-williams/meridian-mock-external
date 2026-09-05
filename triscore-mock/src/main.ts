import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer().listen(envPort('TRISCORE_PORT', 4603)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'triscore-mock', error: String(err) }));
  process.exit(1);
});
