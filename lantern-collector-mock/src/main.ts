import * as path from 'path';
import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

buildServer({ staticDir: process.env.LANTERN_STATIC_DIR || path.resolve(__dirname, '..', 'static') })
  .listen(envPort('LANTERN_COLLECTOR_PORT', 4607))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event: 'service.failed', service: 'lantern-collector-mock', error: String(err) }));
    process.exit(1);
  });
