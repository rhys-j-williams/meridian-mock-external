import { randomUUID } from 'crypto';
import { createMockApp, fixtures, MockApp, sendError, stableHash } from '@meridian/mock-kit';
import { Customer } from '@meridian/domain-fixtures';

/**
 * TriScore credit bureau and identity verification. Score is a pure function of customerId
 * so the same customer gets the same number in every environment, and the KBA questions are
 * built from the customer's own fixture data (their street, their oldest account year, their
 * organisation), so the "correct" answer is derivable by a test without hard coding.
 *
 * The bureau contract is the TriScore Consumer API v3; field names match the WSDL-to-REST shim
 * GIS approved in 2021 (GIS-2274). Report pulls are logged because they are a regulated event.
 */

interface KbaQuestion {
  questionId: string;
  text: string;
  choices: string[];
}

interface KbaSession {
  sessionId: string;
  customerId: string;
  questions: KbaQuestion[];
  answers: string[];
  attempts: number;
  passed: boolean | null;
  createdAt: string;
}

function scoreFor(customerId: string): number {
  // FICO-like range 300-850, weighted toward the 660-790 band
  const h = stableHash(customerId);
  const centre = 660 + (h % 130);
  const tail = ((h >> 12) % 100) < 12 ? -((h >> 20) % 200) : 0;
  return Math.max(300, Math.min(850, centre + tail));
}

function band(score: number): string {
  if (score >= 800) return 'exceptional';
  if (score >= 740) return 'very-good';
  if (score >= 670) return 'good';
  if (score >= 580) return 'fair';
  return 'poor';
}

function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function kbaFor(customer: Customer): { questions: KbaQuestion[]; answers: string[] } {
  const fx = fixtures();
  const accounts = fx.accounts.filter((a) => a.customerId === customer.customerId);
  const oldest = accounts.map((a) => a.openedAt.slice(0, 4)).sort()[0] || '2015';
  const streetWord = customer.address.line1.replace(/^\d+\s*/, '').split(' ')[0];
  const seed = stableHash(customer.customerId);
  const otherStreets = ['Maple', 'Juniper', 'Harbor', 'Cedar', 'Sycamore', 'Prospect'].filter((s) => s !== streetWord);
  const years = [String(Number(oldest) - 3), String(Number(oldest) + 2), String(Number(oldest) + 5)];
  const otherStates = ['CO', 'OR', 'GA', 'MN', 'AZ'].filter((s) => s !== customer.address.state);

  const q: Array<{ q: KbaQuestion; answer: string }> = [
    {
      q: { questionId: 'kba-street', text: 'Which of these street names is associated with your current address?', choices: shuffle([streetWord, ...otherStreets.slice(0, 3)], seed) },
      answer: streetWord
    },
    {
      q: { questionId: 'kba-year', text: 'In what year did you open your oldest Meridian account?', choices: shuffle([oldest, ...years], seed >> 3) },
      answer: oldest
    },
    {
      q: { questionId: 'kba-state', text: 'Which state have you lived in most recently?', choices: shuffle([customer.address.state, ...otherStates.slice(0, 3)], seed >> 5) },
      answer: customer.address.state
    },
    {
      q: { questionId: 'kba-mobile', text: 'Which of these are the last two digits of a mobile number on your file?', choices: shuffle([customer.mobile.slice(-2), '17', '48', '93'].filter((v, i, a) => a.indexOf(v) === i).slice(0, 4), seed >> 7) },
      answer: customer.mobile.slice(-2)
    }
  ];
  const picked = shuffle(q, seed >> 9).slice(0, 3);
  return { questions: picked.map((p) => p.q), answers: picked.map((p) => p.answer) };
}

export function buildServer(): MockApp {
  const mock = createMockApp('triscore-mock');
  const { app, log } = mock;
  const sessions = new Map<string, KbaSession>();
  const pulls: Array<{ customerId: string; purpose: string; at: string; correlationId: string }> = [];

  const customerById = (id: string) => fixtures().customers.find((c) => c.customerId === id);

  const requireSubscriber = (req: import('express').Request, res: import('express').Response): boolean => {
    if (!req.header('x-triscore-subscriber')) {
      sendError(res, 401, 'SUBSCRIBER_REQUIRED', 'X-TriScore-Subscriber header missing');
      return false;
    }
    return true;
  };

  app.post('/v3/credit/score', (req, res) => {
    if (!requireSubscriber(req, res)) return;
    const { customerId, purpose } = req.body as { customerId?: string; purpose?: string };
    const customer = customerId ? customerById(customerId) : undefined;
    if (!customer) {
      sendError(res, 404, 'CONSUMER_NOT_FOUND', 'no bureau file for that consumer');
      return;
    }
    const score = scoreFor(customer.customerId);
    pulls.push({ customerId: customer.customerId, purpose: purpose || 'account-review', at: new Date().toISOString(), correlationId: res.locals.correlationId });
    log.info({ event: 'triscore.pull', customerId: customer.customerId, purpose: purpose || 'account-review', correlationId: res.locals.correlationId });
    const h = stableHash(customer.customerId + ':factors');
    res.json({
      consumerId: customer.customerId,
      score,
      model: 'TriScore 9',
      band: band(score),
      asOf: new Date().toISOString().slice(0, 10),
      factors: [
        { code: 'P01', description: 'Proportion of balances to credit limits is too high on bank revolving or other revolving accounts', impact: h % 3 === 0 ? 'high' : 'medium' },
        { code: 'P14', description: 'Length of time accounts have been established', impact: 'low' },
        { code: 'P10', description: 'Too many inquiries in the last 12 months', impact: (h >> 4) % 2 === 0 ? 'medium' : 'low' }
      ].slice(0, 2 + (h % 2)),
      inquiriesLast12Months: h % 4,
      openTradelines: 3 + (h % 9),
      reportId: `rpt_${randomUUID()}`
    });
  });

  app.get('/v3/credit/score/:customerId', (req, res) => {
    const customer = customerById(req.params.customerId);
    if (!customer) {
      sendError(res, 404, 'CONSUMER_NOT_FOUND', 'no bureau file for that consumer');
      return;
    }
    const score = scoreFor(customer.customerId);
    res.json({ consumerId: customer.customerId, score, band: band(score), model: 'TriScore 9' });
  });

  app.post('/v3/identity/verify', (req, res) => {
    if (!requireSubscriber(req, res)) return;
    const body = req.body as { customerId?: string; firstName?: string; lastName?: string; postalCode?: string; taxIdLastFour?: string };
    const customer = body.customerId ? customerById(body.customerId) : undefined;
    if (!customer) {
      sendError(res, 404, 'CONSUMER_NOT_FOUND', 'no identity record');
      return;
    }
    const checks = {
      name: !body.firstName || (body.firstName.toLowerCase() === customer.firstName.toLowerCase() && (body.lastName || '').toLowerCase() === customer.lastName.toLowerCase()),
      address: !body.postalCode || body.postalCode === customer.address.postalCode,
      taxId: !body.taxIdLastFour || !customer.taxIdLastFour || body.taxIdLastFour === customer.taxIdLastFour
    };
    const passed = Object.values(checks).every(Boolean);
    const h = stableHash(customer.customerId + ':idv');
    res.json({
      consumerId: customer.customerId,
      decision: passed ? (h % 7 === 0 ? 'review' : 'pass') : 'fail',
      checks,
      riskIndicators: h % 7 === 0 ? ['ADDRESS_RECENTLY_CHANGED'] : [],
      verificationId: `idv_${randomUUID()}`
    });
  });

  app.post('/v3/identity/kba/start', (req, res) => {
    if (!requireSubscriber(req, res)) return;
    const { customerId } = req.body as { customerId?: string };
    const customer = customerId ? customerById(customerId) : undefined;
    if (!customer) {
      sendError(res, 404, 'CONSUMER_NOT_FOUND', 'no identity record');
      return;
    }
    const { questions, answers } = kbaFor(customer);
    const session: KbaSession = { sessionId: `kba_${randomUUID()}`, customerId: customer.customerId, questions, answers, attempts: 0, passed: null, createdAt: new Date().toISOString() };
    sessions.set(session.sessionId, session);
    res.json({ sessionId: session.sessionId, questions, expiresIn: 300 });
  });

  app.post('/v3/identity/kba/:sessionId/answer', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'unknown KBA session');
      return;
    }
    if (session.passed !== null) {
      sendError(res, 409, 'SESSION_COMPLETE', 'session already decided');
      return;
    }
    const answers = (req.body as { answers?: Array<{ questionId: string; answer: string }> }).answers || [];
    session.attempts += 1;
    const correct = session.questions.filter((q, i) => answers.find((a) => a.questionId === q.questionId)?.answer === session.answers[i]).length;
    const passed = correct >= 2;
    if (passed || session.attempts >= 2) session.passed = passed;
    log.info({ event: 'triscore.kba.answered', sessionId: session.sessionId, correct, passed, attempts: session.attempts });
    res.json({ sessionId: session.sessionId, correct, required: 2, decision: passed ? 'pass' : session.attempts >= 2 ? 'fail' : 'retry', attemptsRemaining: Math.max(0, 2 - session.attempts) });
  });

  // sandbox-only: lets a test discover the expected answers without duplicating the derivation
  app.get('/debug/kba/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'unknown KBA session');
      return;
    }
    res.json(session);
  });
  app.get('/debug/pulls', (_req, res) => res.json(pulls.slice(-100)));

  return mock;
}
