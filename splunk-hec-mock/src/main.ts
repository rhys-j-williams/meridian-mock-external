import * as path from 'path';
import { envPort } from '@meridian/mock-kit';
import { buildServer } from './server';

const tokens = (process.env.HEC_TOKENS || 'CHANGEME-hec-token,CHANGEME-hec-token-mocks').split(',').map((t) => t.trim()).filter(Boolean);

buildServer({
  dataDir: process.env.HEC_DATA_DIR || path.resolve(process.cwd(), 'data'),
  tokens
}).listen(envPort('SPLUNK_HEC_PORT', 4606)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ event: 'service.failed', service: 'splunk-hec-mock', error: String(err) }));
  process.exit(1);
});
