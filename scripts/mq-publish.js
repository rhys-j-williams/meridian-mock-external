#!/usr/bin/env node
/*
 * Publish one message to a queue over STOMP (Artemis 61613, or IBM MQ if you have the STOMP
 * bridge on, which nobody does). Used by smoke.sh to drop account events on ACCT.EVENTS when
 * there is no rpk around. Reads the body from stdin.
 *
 *   echo '{"eventId":"..."}' | node scripts/mq-publish.js ACCT.EVENTS [--header key=value ...]
 *
 * Env: STOMP_HOST (localhost), STOMP_PORT (61613), STOMP_LOGIN (artemis), STOMP_PASSCODE.
 */
'use strict';
const stompit = require('stompit');

const queue = process.argv[2];
if (!queue) {
  process.stderr.write('usage: mq-publish.js <queue> [--header k=v ...] < body\n');
  process.exit(2);
}
const headers = { destination: queue, 'content-type': 'application/json', persistent: 'true' };
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--header' && process.argv[i + 1]) {
    const [k, ...v] = process.argv[++i].split('=');
    headers[k] = v.join('=');
  }
}

let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', () => {
  const connectOptions = {
    host: process.env.STOMP_HOST || 'localhost',
    port: Number(process.env.STOMP_PORT || 61613),
    connectHeaders: {
      host: '/',
      login: process.env.STOMP_LOGIN || 'artemis',
      passcode: process.env.STOMP_PASSCODE || 'CHANGEME-artemis',
      'heart-beat': '0,0'
    }
  };
  stompit.connect(connectOptions, (err, client) => {
    if (err) {
      process.stderr.write(`mq-publish: connect failed: ${err.message}\n`);
      process.exit(1);
    }
    const frame = client.send(headers);
    frame.write(body);
    frame.end();
    client.disconnect(() => process.exit(0));
  });
});
