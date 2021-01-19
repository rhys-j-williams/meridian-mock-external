import * as path from 'path';
import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

const port = envPort('BEDROCK_CORE_PORT', 4600);
const stompHost = process.env.BEDROCK_STOMP_HOST;

const mock = buildServer({
  batchDir: process.env.BEDROCK_BATCH_DIR || path.resolve(process.cwd(), 'data/batch'),
  batchIntervalMinutes: Number(process.env.BEDROCK_BATCH_INTERVAL_MINUTES ?? 5),
  stomp: stompHost
    ? {
        host: stompHost,
        port: envPort('BEDROCK_STOMP_PORT', 61613),
        login: process.env.BEDROCK_STOMP_LOGIN || 'artemis',
        passcode: process.env.BEDROCK_STOMP_PASSCODE || 'CHANGEME-artemis'
      }
    : undefined
});

mock.listen(port).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'bedrock-core-mock', error: String(err) }));
  process.exit(1);
});

process.on('SIGTERM', () => {
  mock.shutdown();
  process.exit(0);
});
