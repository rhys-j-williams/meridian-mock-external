import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer().listen(envPort('TICKERHAUS_PORT', 4602)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'tickerhaus-mock', error: String(err) }));
  process.exit(1);
});
