import {
  decodeAccountRecord,
  decodeZonedDecimal,
  encodeZonedDecimal,
  DecodedAccountRecord
} from '@meridian/domain-fixtures';

/**
 * MTBREQ / MTBRESP: the CICS request and reply envelopes bedrock-adapter-service puts on
 * BEDROCK.REQ and reads off BEDROCK.RESP. These two layouts are *not* in platform-services/copybooks
 * because Core Banking never published them; the adapter team reverse engineered them from a
 * CEDF trace in 2019 (PLAT-1187) and this file is the closest thing to a copybook that exists.
 *
 *   MTBREQ  (200)             MTBRESP header (56) followed by N payload records
 *   REQ-FUNC        X(08)     RESP-FUNC     X(08)
 *   REQ-CORR-ID     X(36)     RESP-CORR-ID  X(36)
 *   REQ-ACCT-ID     X(16)     RESP-RC       9(04)   0000 ok, 0004 warn, 0008 business, 0012 abend
 *   REQ-CUST-ID     X(12)     RESP-ABEND    X(04)   spaces or a CICS abend code
 *   REQ-AMOUNT      S9(13)    RESP-COUNT    9(04)   number of payload records
 *   REQ-TXN-ID      X(16)
 *   REQ-MCC         X(04)
 *   REQ-CHANNEL     X(08)
 *   REQ-DESC        X(64)
 *   FILLER          X(23)
 *
 * Payload record is MTBACCT (136) for ACCTINQ / CUSTACCT and MTBTRAN (160) for TRANPOST / TRANLIST.
 */

export const REQ_LENGTH = 200;
export const RESP_HEADER_LENGTH = 56;

export type Func = 'ACCTINQ' | 'CUSTACCT' | 'TRANPOST' | 'TRANLIST' | 'PING';

export interface BedrockRequest {
  func: string;
  correlationId: string;
  accountId: string;
  customerId: string;
  /** null when the field was spaces (inquiry functions do not carry an amount) */
  amountMinor: number | null;
  transactionId: string;
  mcc: string;
  channel: string;
  description: string;
}

export interface BedrockResponse {
  func: string;
  correlationId: string;
  returnCode: number;
  abendCode: string;
  count: number;
  records: string[];
}

export class RecordFormatError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

const text = (value: string, width: number) => value.slice(0, width).padEnd(width, ' ');
const num = (value: number, width: number) => String(value).padStart(width, '0');

export function encodeRequest(req: Partial<BedrockRequest> & { func: string }): string {
  return [
    text(req.func, 8),
    text(req.correlationId || '', 36),
    text(req.accountId || '', 16),
    text(req.customerId || '', 12),
    req.amountMinor === null || req.amountMinor === undefined ? ' '.repeat(13) : encodeZonedDecimal(req.amountMinor, 13),
    text(req.transactionId || '', 16),
    text(req.mcc || '', 4),
    text(req.channel || '', 8),
    text(req.description || '', 64)
  ].join('').padEnd(REQ_LENGTH, ' ');
}

export function decodeRequest(record: string): BedrockRequest {
  if (record.length < REQ_LENGTH - 23) {
    // filler is optional: the adapter's 2019 build sent 177 byte messages and Bedrock accepted them
    throw new RecordFormatError('MTBREQ', `request must be at least 177 positions, received ${record.length}`);
  }
  const padded = record.padEnd(REQ_LENGTH, ' ');
  const slice = (start: number, width: number) => padded.substr(start, width).trim();
  const amountField = padded.substr(72, 13);
  let amountMinor: number | null = null;
  if (amountField.trim().length > 0) {
    try {
      amountMinor = decodeZonedDecimal(amountField);
    } catch (err) {
      throw new RecordFormatError('REQ-AMOUNT', (err as Error).message);
    }
    if (Number.isNaN(amountMinor)) {
      throw new RecordFormatError('REQ-AMOUNT', `non numeric data in REQ-AMOUNT: "${amountField}"`);
    }
  }
  return {
    func: slice(0, 8),
    correlationId: slice(8, 36),
    accountId: slice(44, 16),
    customerId: slice(60, 12),
    amountMinor,
    transactionId: slice(85, 16),
    mcc: slice(101, 4),
    channel: slice(105, 8),
    description: slice(113, 64)
  };
}

export function encodeResponse(resp: BedrockResponse): string {
  const header = [
    text(resp.func, 8),
    text(resp.correlationId, 36),
    num(resp.returnCode, 4),
    text(resp.abendCode, 4),
    num(resp.count, 4)
  ].join('');
  return header + resp.records.join('');
}

export function decodeResponse(message: string, recordLength: number): BedrockResponse {
  if (message.length < RESP_HEADER_LENGTH) {
    throw new RecordFormatError('MTBRESP', `response header must be 56 positions, received ${message.length}`);
  }
  const count = Number(message.substr(52, 4));
  const records: string[] = [];
  for (let i = 0; i < count; i++) {
    records.push(message.substr(RESP_HEADER_LENGTH + i * recordLength, recordLength));
  }
  return {
    func: message.substr(0, 8).trim(),
    correlationId: message.substr(8, 36).trim(),
    returnCode: Number(message.substr(44, 4)),
    abendCode: message.substr(48, 4).trim(),
    count,
    records
  };
}

export interface DecodedTransactionRecord {
  transactionId: string;
  accountId: string;
  postedOn: string;
  settledOn: string | null;
  amountMinor: number;
  runningBalanceMinor: number;
  mcc: string;
  channel: string;
  status: string;
  description: string;
}

/** MTBTRAN decoder. domain-fixtures only ships the encoder for this one (PLAT-2277 still open). */
export function decodeTransactionRecord(record: string): DecodedTransactionRecord {
  if (record.length < 160) {
    throw new RecordFormatError('MTBTRAN', `MTBTRAN record must be 160 positions, received ${record.length}`);
  }
  const slice = (start: number, width: number) => record.substr(start, width).trim();
  const settled = slice(40, 8);
  return {
    transactionId: slice(0, 16),
    accountId: slice(16, 16),
    postedOn: slice(32, 8),
    settledOn: settled.length === 0 ? null : settled,
    amountMinor: decodeZonedDecimal(record.substr(48, 13)),
    runningBalanceMinor: decodeZonedDecimal(record.substr(61, 13)),
    mcc: slice(74, 4),
    channel: slice(78, 8),
    status: slice(86, 10),
    description: slice(96, 64)
  };
}

export { decodeAccountRecord, DecodedAccountRecord };
