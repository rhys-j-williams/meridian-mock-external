import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { decodeAccountRecord } from '@meridian/domain-fixtures';
import { decodeResponse, decodeTransactionRecord, encodeRequest } from './messages';
import { buildServer, BedrockMock } from './server';

/**
 * Puts fixed width requests on BEDROCK.REQ through the REST facade and reads the fixed width
 * replies off BEDROCK.RESP, then decodes them with the shared copybook helpers. This is the
 * contract bedrock-adapter-service codes against.
 */

function request(url: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('bedrock-core-mock fixed width round trip', () => {
  let mock: BedrockMock;
  let server: http.Server;
  let base: string;
  const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-batch-'));

  beforeAll(async () => {
    mock = buildServer({ batchDir, batchIntervalMinutes: 0 });
    server = await new Promise<http.Server>((resolve) => {
      const s = mock.app.listen(0, () => resolve(s));
    });
    base = `http://localhost:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    mock.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(batchDir, { recursive: true, force: true });
  });

  async function exchange(wire: string, correlationId: string) {
    const put = await request(`${base}/mq/BEDROCK.REQ`, 'POST', wire, { 'content-type': 'text/plain', 'x-correlation-id': correlationId });
    expect(put.status).toBe(202);
    const get = await request(`${base}/mq/BEDROCK.RESP?correlationId=${correlationId}&wait=2000`, 'GET');
    expect(get.status).toBe(200);
    expect(get.headers['x-correlation-id']).toBe(correlationId);
    return get.body;
  }

  it('ACCTINQ returns an MTBACCT record whose overpunched balance matches the ledger', async () => {
    const account = mock.ledger.allAccounts().find((a) => a.currentBalanceMinor < 0) || mock.ledger.allAccounts()[0];
    const reply = await exchange(encodeRequest({ func: 'ACCTINQ', correlationId: 'rt-1', accountId: account.accountId }), 'rt-1');
    const resp = decodeResponse(reply, 136);
    expect(resp.returnCode).toBe(0);
    expect(resp.abendCode).toBe('');
    expect(resp.count).toBe(1);
    expect(resp.records[0]).toHaveLength(136);
    const decoded = decodeAccountRecord(resp.records[0]);
    expect(decoded.accountId).toBe(account.accountId);
    expect(decoded.currentBalanceMinor).toBe(account.currentBalanceMinor);
    expect(decoded.availableBalanceMinor).toBe(account.availableBalanceMinor);
    expect(decoded.routingNumber).toBe('021000000');
  });

  it('TRANPOST debits the balance, replies with MTBTRAN, and replays as RC 0004', async () => {
    const account = mock.ledger.allAccounts().find((a) => a.type === 'checking' && a.status === 'open' && a.availableBalanceMinor > 50_00);
    expect(account).toBeDefined();
    const before = (account as { currentBalanceMinor: number }).currentBalanceMinor;
    const wire = encodeRequest({
      func: 'TRANPOST', correlationId: 'rt-2', accountId: (account as { accountId: string }).accountId,
      amountMinor: -4287, transactionId: 'IDEMP-0001', mcc: '5812', channel: 'CARD', description: 'ROUND TRIP TEST'
    });
    const resp = decodeResponse(await exchange(wire, 'rt-2'), 160);
    expect(resp.returnCode).toBe(0);
    const t = decodeTransactionRecord(resp.records[0]);
    expect(t.amountMinor).toBe(-4287);
    expect(t.runningBalanceMinor).toBe(before - 4287);
    expect(t.settledOn).toBeNull();
    expect(mock.ledger.account(t.accountId)?.currentBalanceMinor).toBe(before - 4287);

    const replay = decodeResponse(await exchange(wire, 'rt-2b'), 160);
    expect(replay.returnCode).toBe(4);
    expect(mock.ledger.account(t.accountId)?.currentBalanceMinor).toBe(before - 4287);
  });

  it('rejects an overdraft with RC 0008 and no abend', async () => {
    const account = mock.ledger.allAccounts().find((a) => a.type === 'savings' && a.status === 'open') as { accountId: string };
    const wire = encodeRequest({ func: 'TRANPOST', correlationId: 'rt-3', accountId: account.accountId, amountMinor: -99_999_999_99, channel: 'WIRE' });
    const resp = decodeResponse(await exchange(wire, 'rt-3'), 160);
    expect(resp.returnCode).toBe(8);
    expect(resp.abendCode).toBe('');
    expect(resp.count).toBe(0);
  });

  it('abends ASRA on a corrupt zoned decimal and AEY9 on an unknown function', async () => {
    const good = encodeRequest({ func: 'TRANPOST', correlationId: 'rt-4', accountId: 'ACC-X', amountMinor: 1 });
    const corrupt = good.substr(0, 72) + '0000000000$#!' + good.substr(85);
    const asra = decodeResponse(await exchange(corrupt, 'rt-4'), 160);
    expect(asra.returnCode).toBe(12);
    expect(asra.abendCode).toBe('ASRA');

    const aey9 = decodeResponse(await exchange(encodeRequest({ func: 'FROBNICA', correlationId: 'rt-5' }), 'rt-5'), 136);
    expect(aey9.returnCode).toBe(12);
    expect(aey9.abendCode).toBe('AEY9');
    expect(mock.ledger.stats().abends).toBe(2);
  });

  it('runs end of day, settles the pending posting and writes a report file', async () => {
    const run = await request(`${base}/debug/batch/run`, 'POST');
    expect(run.status).toBe(200);
    const { file } = JSON.parse(run.body);
    const report = fs.readFileSync(file, 'utf8');
    expect(report).toContain('MTBD900E  BEDROCK END OF DAY');
    expect(report).toMatch(/PENDING SETTLED\s+0000000[1-9]/);
    expect(report).toContain('END OF REPORT  RC=0000');
    const list = await request(`${base}/debug/batch/reports`, 'GET');
    expect(JSON.parse(list.body)).toHaveLength(1);
  });

  it('answers the JSON debug helper with decoded records', async () => {
    const customer = mock.ledger.allAccounts()[0].customerId;
    const res = await request(`${base}/debug/request`, 'POST', JSON.stringify({ func: 'CUSTACCT', customerId: customer }), { 'content-type': 'application/json' });
    const body = JSON.parse(res.body);
    expect(body.request).toHaveLength(200);
    expect(body.decoded.returnCode).toBe(0);
    expect(body.decoded.records.length).toBeGreaterThan(0);
    expect(body.decoded.records[0].customerId).toBe(customer);
  });
});
