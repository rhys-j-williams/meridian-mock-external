import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer({ settleAfterMs: Number(process.env.PAYLINK_SETTLE_MS ?? 3000) }).listen(envPort('PAYLINK_PORT', 4604)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'paylink-network-mock', error: String(err) }));
  process.exit(1);
});
