import { decodeZonedDecimal, encodeZonedDecimal } from '@meridian/domain-fixtures';
import { decodeRequest, decodeResponse, decodeTransactionRecord, encodeRequest, encodeResponse, REQ_LENGTH } from './messages';

describe('MTBREQ / MTBRESP envelopes', () => {
  it('encodes a 200 position request with a signed overpunch amount', () => {
    const wire = encodeRequest({
      func: 'TRANPOST', correlationId: 'corr-1', accountId: 'ACC-000001', customerId: 'CUS-000001',
      amountMinor: -1234, transactionId: 'TXN-1', mcc: '5411', channel: 'CARD', description: 'GROCERY'
    });
    expect(wire).toHaveLength(REQ_LENGTH);
    expect(wire.substr(72, 13)).toBe('000000000123M');
    expect(decodeRequest(wire)).toEqual({
      func: 'TRANPOST', correlationId: 'corr-1', accountId: 'ACC-000001', customerId: 'CUS-000001',
      amountMinor: -1234, transactionId: 'TXN-1', mcc: '5411', channel: 'CARD', description: 'GROCERY'
    });
  });

  it('treats spaces in REQ-AMOUNT as no amount, not zero', () => {
    const wire = encodeRequest({ func: 'ACCTINQ', accountId: 'ACC-000001' });
    expect(wire.substr(72, 13)).toBe(' '.repeat(13));
    expect(decodeRequest(wire).amountMinor).toBeNull();
  });

  it('rejects non numeric data in the amount field so the caller can raise ASRA', () => {
    const wire = encodeRequest({ func: 'TRANPOST', accountId: 'ACC-000001', amountMinor: 100 });
    const corrupt = wire.substr(0, 72) + '00000000ABC1{' + wire.substr(85);
    expect(() => decodeRequest(corrupt)).toThrow(/REQ-AMOUNT|non numeric|not a zoned/);
  });

  it('accepts the 177 byte adapter build without the trailing filler', () => {
    const wire = encodeRequest({ func: 'PING', correlationId: 'c' }).substr(0, 177);
    expect(decodeRequest(wire).func).toBe('PING');
  });

  it('round-trips the overpunch table at both ends of the range', () => {
    for (const minor of [0, 1, 9, 10, 4095, -4095, 364085, -364085, 9999999999999, -9999999999999]) {
      expect(decodeZonedDecimal(encodeZonedDecimal(minor, 13))).toBe(minor);
    }
    expect(encodeZonedDecimal(364085, 13)).toBe('000000036408E');
    expect(encodeZonedDecimal(-364085, 13)).toBe('000000036408N');
    expect(encodeZonedDecimal(0, 13)).toBe('000000000000{');
  });

  it('frames a response header and slices the payload by record length', () => {
    const rec = 'X'.repeat(160);
    const wire = encodeResponse({ func: 'TRANLIST', correlationId: 'abc', returnCode: 4, abendCode: '', count: 2, records: [rec, rec] });
    expect(wire.substr(44, 4)).toBe('0004');
    expect(wire.substr(48, 4)).toBe('    ');
    expect(wire.substr(52, 4)).toBe('0002');
    const decoded = decodeResponse(wire, 160);
    expect(decoded.records).toEqual([rec, rec]);
    expect(decoded.abendCode).toBe('');
  });

  it('decodes MTBTRAN and treats a spaces settled date as null (INC0044182)', () => {
    const record = [
      'TXN-00000001'.padEnd(16), 'ACC-000001'.padEnd(16), '20240102', '        ',
      '000000000012K', '000000098765{', '5812', 'CARD'.padEnd(8), 'PENDING'.padEnd(10), 'COFFEE'.padEnd(64)
    ].join('');
    const t = decodeTransactionRecord(record);
    expect(t.settledOn).toBeNull();
    expect(t.amountMinor).toBe(-122);
    expect(t.runningBalanceMinor).toBe(987650);
    expect(t.status).toBe('PENDING');
  });
});
