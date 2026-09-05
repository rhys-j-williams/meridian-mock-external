#!/usr/bin/env node
/*
 * In-process fallback for `docker compose up`: runs every mock as a child process from this
 * directory with the PORTS.md ports, restarts one if it dies, and writes pids to .estate/pids so
 * estate-down.sh can kill them. Node 18. No dependencies on purpose; this has to work on a box
 * where npm install has half failed.
 *
 *   node scripts/start-all.js            foreground, Ctrl-C stops everything
 *   node scripts/start-all.js --daemon   detach, log to .estate/logs/<mock>.log
 *   node scripts/start-all.js --only keystone-idp-mock,vault-mock
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, '.estate');
const LOGS = path.join(STATE, 'logs');

const MOCKS = [
  { name: 'keystone-idp-mock', port: 4400, env: { KEYSTONE_IDP_PORT: '4400', KEYSTONE_ISSUER: 'http://localhost:4400' } },
  { name: 'bedrock-core-mock', port: 4600, env: { BEDROCK_CORE_PORT: '4600', BEDROCK_BATCH_INTERVAL_MINUTES: '5' } },
  { name: 'aggregio-mock', port: 4601, env: { AGGREGIO_PORT: '4601' } },
  { name: 'tickerhaus-mock', port: 4602, env: { TICKERHAUS_PORT: '4602' } },
  { name: 'triscore-mock', port: 4603, env: { TRISCORE_PORT: '4603' } },
  { name: 'paylink-network-mock', port: 4604, env: { PAYLINK_PORT: '4604' } },
  { name: 'vault-mock', port: 4605, env: { VAULT_PORT: '4605' } },
  { name: 'splunk-hec-mock', port: 4606, env: { SPLUNK_HEC_PORT: '4606', HEC_TOKENS: 'CHANGEME-hec-token,CHANGEME-hec-token-mocks' } },
  { name: 'lantern-collector-mock', port: 4607, env: { LANTERN_COLLECTOR_PORT: '4607' } },
  { name: 'semaphore-flags-mock', port: 4608, env: { SEMAPHORE_PORT: '4608' } },
  { name: 'ldap-mock', port: 4609, env: { LDAP_PORT: '4609', LDAP_HTTP_PORT: '14609' }, healthPort: 14609 }
];

const args = process.argv.slice(2);
const daemon = args.includes('--daemon');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
const selected = MOCKS.filter((m) => !only || only.has(m.name));

fs.mkdirSync(LOGS, { recursive: true });
const pidFile = path.join(STATE, 'pids');
const pids = {};
let stopping = false;

function start(mock, attempt) {
  const cwd = path.join(ROOT, mock.name);
  const entry = path.join(cwd, 'dist', 'main.js');
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[start-all] ${mock.name}: dist/main.js missing, run npm run build first\n`);
    return;
  }
  const env = Object.assign({}, process.env, {
    NODE_ENV: process.env.NODE_ENV || 'development',
    SPLUNK_HEC_URL: process.env.SPLUNK_HEC_URL || 'http://localhost:4606/services/collector/event',
    SPLUNK_HEC_TOKEN: process.env.SPLUNK_HEC_TOKEN || 'CHANGEME-hec-token-mocks'
  }, mock.env);
  const logStream = daemon ? fs.openSync(path.join(LOGS, `${mock.name}.log`), 'a') : 'inherit';
  const child = spawn(process.execPath, [entry], { cwd, env, stdio: ['ignore', logStream, logStream], detached: daemon });
  pids[mock.name] = child.pid;
  fs.writeFileSync(pidFile, JSON.stringify(pids, null, 2));
  process.stdout.write(`[start-all] ${mock.name} pid ${child.pid} port ${mock.port}\n`);
  child.on('exit', (code) => {
    delete pids[mock.name];
    if (stopping) return;
    const next = (attempt || 0) + 1;
    if (next > 5) {
      process.stderr.write(`[start-all] ${mock.name} exited ${code} five times, giving up\n`);
      return;
    }
    process.stderr.write(`[start-all] ${mock.name} exited ${code}, restarting (${next}/5)\n`);
    setTimeout(() => start(mock, next), 1000 * next);
  });
  if (daemon) child.unref();
}

for (const m of selected) start(m, 0);

if (daemon) {
  // give the children a moment to bind, then leave them running
  setTimeout(() => {
    process.stdout.write(`[start-all] detached, pids in ${pidFile}, logs in ${LOGS}\n`);
    process.exit(0);
  }, 1500);
} else {
  const stop = () => {
    stopping = true;
    for (const pid of Object.values(pids)) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }
    }
    try { fs.unlinkSync(pidFile); } catch (e) { /* fine */ }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
