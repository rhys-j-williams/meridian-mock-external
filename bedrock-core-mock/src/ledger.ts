import {
  Account,
  Customer,
  Transaction,
  encodeAccountRecord,
  encodeTransactionRecord,
  FixtureSet
} from '@meridian/domain-fixtures';
import { BedrockRequest, BedrockResponse, RecordFormatError } from './messages';

/**
 * In memory ledger. Balances and postings are seeded from the fixture set and mutated by
 * TRANPOST and by the end of day batch. Nothing is persisted; restarting the mock restores
 * the fixtures, which is what the demo wants.
 *
 * Return codes follow the Bedrock convention: 0000 success, 0004 warning (partial result),
 * 0008 business rejection (no abend), 0012 transaction abended. The two abend scenarios the
 * adapter has to handle are ASRA (data exception: a non numeric byte in a zoned decimal
 * field, the S0C7 everybody has seen once) and AEY9 (unsupported function code, which is
 * what you get when somebody deploys a new adapter before the Bedrock release).
 */

export const RC_OK = 0;
export const RC_WARN = 4;
export const RC_BUSINESS = 8;
export const RC_ABEND = 12;

export interface Posting {
  transaction: Transaction;
  postedBy: 'seed' | 'online' | 'batch';
}

export interface LedgerStats {
  accounts: number;
  postings: number;
  onlinePostings: number;
  batchRuns: number;
  lastBatchAt: string | null;
  abends: number;
}

export class Ledger {
  private readonly customers = new Map<string, Customer>();
  private readonly accounts = new Map<string, Account>();
  private readonly postings = new Map<string, Posting[]>();
  private readonly idempotency = new Map<string, string>();
  private online = 0;
  private abends = 0;
  private batchRuns = 0;
  private lastBatchAt: string | null = null;
  private seq = 0;

  constructor(fixtures: FixtureSet) {
    for (const c of fixtures.customers) this.customers.set(c.customerId, c);
    for (const a of fixtures.accounts) {
      this.accounts.set(a.accountId, { ...a });
      this.postings.set(a.accountId, []);
    }
    for (const t of fixtures.transactions) {
      this.postings.get(t.accountId)?.push({ transaction: { ...t }, postedBy: 'seed' });
    }
    for (const list of this.postings.values()) {
      list.sort((x, y) => x.transaction.postedAt.localeCompare(y.transaction.postedAt));
    }
  }

  stats(): LedgerStats {
    let postings = 0;
    for (const list of this.postings.values()) postings += list.length;
    return {
      accounts: this.accounts.size, postings, onlinePostings: this.online,
      batchRuns: this.batchRuns, lastBatchAt: this.lastBatchAt, abends: this.abends
    };
  }

  account(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  allAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  accountsForCustomer(customerId: string): Account[] {
    return this.allAccounts().filter((a) => a.customerId === customerId);
  }

  postingsFor(accountId: string): Posting[] {
    return this.postings.get(accountId) || [];
  }

  private customerFor(account: Account): Customer {
    const c = this.customers.get(account.customerId);
    if (!c) throw new Error(`account ${account.accountId} references unknown customer ${account.customerId}`);
    return c;
  }

  private nextTransactionId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${Date.now().toString(36).toUpperCase()}${String(this.seq).padStart(4, '0')}`.slice(0, 16);
  }

  /** Apply a posting to an account. Used by TRANPOST and by the batch. */
  post(account: Account, amountMinor: number, description: string, channel: Transaction['channel'],
       mcc: string, postedBy: Posting['postedBy'], transactionId?: string): Transaction {
    account.currentBalanceMinor += amountMinor;
    account.availableBalanceMinor += amountMinor;
    const now = new Date().toISOString();
    const transaction: Transaction = {
      transactionId: transactionId || this.nextTransactionId(postedBy === 'batch' ? 'TB' : 'TO'),
      accountId: account.accountId,
      postedAt: now,
      settledAt: postedBy === 'online' ? null : now,
      description,
      merchantName: description.slice(0, 30),
      merchantCategoryCode: mcc || '0000',
      category: postedBy === 'batch' ? 'income' : 'transfers',
      amountMinor,
      runningBalanceMinor: account.currentBalanceMinor,
      status: postedBy === 'online' ? 'pending' : 'posted',
      channel
    };
    this.postings.get(account.accountId)?.push({ transaction, postedBy });
    if (postedBy === 'online') this.online += 1;
    return transaction;
  }

  handle(req: BedrockRequest): BedrockResponse {
    const base = { func: req.func, correlationId: req.correlationId, abendCode: '' };
    switch (req.func) {
      case 'PING':
        return { ...base, returnCode: RC_OK, count: 0, records: [] };

      case 'ACCTINQ': {
        const account = this.accounts.get(req.accountId);
        if (!account) return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        return { ...base, returnCode: RC_OK, count: 1, records: [encodeAccountRecord(account, this.customerFor(account))] };
      }

      case 'CUSTACCT': {
        const accounts = this.accountsForCustomer(req.customerId);
        if (accounts.length === 0) return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        // MTBRESP count is 9(04) but the adapter's buffer is 32k, so Bedrock caps at 200 records
        // and returns RC 0004 when it truncates. Nobody has 200 accounts in the fixtures.
        const capped = accounts.slice(0, 200);
        return {
          ...base,
          returnCode: capped.length < accounts.length ? RC_WARN : RC_OK,
          count: capped.length,
          records: capped.map((a) => encodeAccountRecord(a, this.customerFor(a)))
        };
      }

      case 'TRANLIST': {
        const account = this.accounts.get(req.accountId);
        if (!account) return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        const list = this.postingsFor(req.accountId).slice(-200).reverse();
        return { ...base, returnCode: RC_OK, count: list.length, records: list.map((p) => encodeTransactionRecord(p.transaction)) };
      }

      case 'TRANPOST': {
        const account = this.accounts.get(req.accountId);
        if (!account) return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        if (req.amountMinor === null) {
          throw new RecordFormatError('REQ-AMOUNT', 'TRANPOST without an amount');
        }
        if (req.transactionId && this.idempotency.has(req.transactionId)) {
          // replay: return the original posting with RC 0004 so the adapter knows it was a dup
          const original = this.postingsFor(req.accountId).find((p) => p.transaction.transactionId === this.idempotency.get(req.transactionId));
          return { ...base, returnCode: RC_WARN, count: original ? 1 : 0, records: original ? [encodeTransactionRecord(original.transaction)] : [] };
        }
        if (account.status === 'closed' || account.status === 'restricted') {
          return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        }
        if (req.amountMinor < 0 && account.availableBalanceMinor + req.amountMinor < -(account.creditLimitMinor || 0)) {
          return { ...base, returnCode: RC_BUSINESS, count: 0, records: [] };
        }
        const channel = (req.channel.toLowerCase() || 'internal') as Transaction['channel'];
        const txn = this.post(account, req.amountMinor, req.description || 'ONLINE POSTING', channel, req.mcc, 'online');
        if (req.transactionId) this.idempotency.set(req.transactionId, txn.transactionId);
        return { ...base, returnCode: RC_OK, count: 1, records: [encodeTransactionRecord(txn)] };
      }

      default:
        this.abends += 1;
        return { ...base, returnCode: RC_ABEND, abendCode: 'AEY9', count: 0, records: [] };
    }
  }

  /** ASRA path: called by the transport when the request could not even be decoded. */
  abend(correlationId: string, func: string): BedrockResponse {
    this.abends += 1;
    return { func: func || 'UNKNOWN', correlationId, returnCode: RC_ABEND, abendCode: 'ASRA', count: 0, records: [] };
  }

  /**
   * End of day. Accrues interest on interest bearing accounts (daily rate from the fixture basis
   * points, rounded half up to the cent the way Bedrock does), settles pending online postings,
   * and returns the report lines. The real MTBD900E job takes four hours; this takes a tick.
   */
  runEndOfDay(now = new Date()): { cycle: string; lines: string[]; interestPostings: number; settled: number } {
    this.batchRuns += 1;
    this.lastBatchAt = now.toISOString();
    const cycle = now.toISOString().slice(0, 10).replace(/-/g, '') + String(this.batchRuns).padStart(3, '0');
    const lines: string[] = [];
    let interestPostings = 0;
    let settled = 0;
    let totalInterest = 0;

    for (const account of this.accounts.values()) {
      if (account.status !== 'open') continue;
      for (const p of this.postingsFor(account.accountId)) {
        if (p.transaction.status === 'pending' && p.postedBy === 'online') {
          p.transaction.status = 'posted';
          p.transaction.settledAt = now.toISOString();
          settled += 1;
        }
      }
      const bps = account.interestRateBasisPoints;
      if (bps && account.currentBalanceMinor > 0 && (account.type === 'savings' || account.type === 'certificate' || account.type === 'business-savings')) {
        const interest = Math.round(account.currentBalanceMinor * bps / 10_000 / 365);
        if (interest > 0) {
          this.post(account, interest, 'INTEREST PAID', 'internal', '6012', 'batch');
          interestPostings += 1;
          totalInterest += interest;
          lines.push(`${account.accountId.padEnd(16)} ${account.type.toUpperCase().padEnd(20)} INT ${String(interest).padStart(13, '0')} BAL ${String(account.currentBalanceMinor).padStart(13, '0')}`);
        }
      }
    }

    const report = [
      `MTBD900E  BEDROCK END OF DAY  CYCLE ${cycle}  RUN ${now.toISOString()}`,
      `ACCOUNTS PROCESSED ${String(this.accounts.size).padStart(8, '0')}`,
      `PENDING SETTLED    ${String(settled).padStart(8, '0')}`,
      `INTEREST POSTINGS  ${String(interestPostings).padStart(8, '0')}  TOTAL MINOR ${String(totalInterest).padStart(13, '0')}`,
      ''.padEnd(72, '-'),
      ...lines,
      ''.padEnd(72, '-'),
      `END OF REPORT  RC=0000`
    ];
    return { cycle, lines: report, interestPostings, settled };
  }
}
