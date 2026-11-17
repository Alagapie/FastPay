import { test } from 'node:test';
import assert from 'node:assert/strict';
import { understand } from '../src/understand/index.js';
import { localDate, rangeToUtc, resolveDatePhrase } from '../src/understand/dates.js';
import { createMetaClient } from '../src/llm.js';

const TZ = 'Africa/Lagos';
// Thursday 12 Nov 2026, 10:00 in Lagos
const NOW = new Date('2026-11-12T09:00:00Z');
const run = (message, opts = {}) => understand({ message, now: NOW, timezone: TZ, ...opts });

test('the example from the module brief', async () => {
  const { extraction, method } = await run("I sent Musa $50 yesterday, but he hasn't received it.");
  assert.equal(method, 'rules');
  assert.equal(extraction.amount_cents, 5000);
  assert.equal(extraction.currency, 'USD');
  assert.equal(extraction.counterparty, 'Musa');
  assert.deepEqual([extraction.date_range.from, extraction.date_range.to], ['2026-11-11', '2026-11-11']);
  assert.equal(extraction.complaint_type, 'RECIPIENT_NOT_CREDITED');
});

test('classifies the different kinds of complaint', async () => {
  const cases = [
    ['I added $100 with PayPal this morning and it is not in my balance', 'TOP_UP_NOT_REFLECTED'],
    ['I cashed out $45 to my PayPal on 10 Nov, it never arrived', 'CASH_OUT_NOT_RECEIVED'],
    ['Musa said he sent me 30 dollars 2 days ago but I have not received it', 'EXPECTED_MONEY_NOT_RECEIVED'],
    ['I was charged twice when I paid Ibrahim $15', 'DUPLICATE_PAYMENT'],
    ["I don't recognise a payment of $12 on Monday", 'UNRECOGNIZED_TRANSACTION'],
    ['My payment to Aisha failed but the money was not returned', 'REFUND_NOT_RECEIVED'],
    ['They took more than I sent, wrong amount', 'WRONG_AMOUNT'],
    ['Something is off with my account', 'OTHER'],
  ];
  for (const [message, type] of cases) {
    assert.equal((await run(message)).extraction.complaint_type, type, message);
  }
});

test('finds names in different sentence shapes', async () => {
  assert.equal((await run('I sent $20 to Aisha Bello on Monday')).extraction.counterparty, 'Aisha Bello');
  assert.equal((await run('Paid Chinedu 15 dollars')).extraction.counterparty, 'Chinedu');
  assert.equal((await run('I sent money to musa@example.com')).extraction.counterparty, 'musa@example.com');
  assert.equal((await run('Sent $5 to FP1234567890 today')).extraction.counterparty, 'FP1234567890');
  assert.equal((await run('I sent $50 yesterday')).extraction.counterparty, null);
});

test('a follow-up message adds to and corrects the earlier details', async () => {
  const first = await run('I sent Musa money yesterday and he did not get it');
  assert.equal(first.extraction.amount_cents, null);
  const second = await run('It was $40', { previous: first.extraction });
  assert.equal(second.extraction.amount_cents, 4000);
  assert.equal(second.extraction.counterparty, 'Musa');
  assert.equal(second.extraction.complaint_type, 'RECIPIENT_NOT_CREDITED');
  assert.equal(second.extraction.date_range.from, '2026-11-11');
});

test('reads dates in the customer timezone', () => {
  const r = (p) => resolveDatePhrase(p, NOW, TZ);
  assert.deepEqual([r('today').from, r('today').to], ['2026-11-12', '2026-11-12']);
  assert.equal(r('yesterday').from, '2026-11-11');
  assert.equal(r('the day before yesterday').from, '2026-11-10');
  assert.equal(r('3 days ago').from, '2026-11-09');
  assert.equal(r('on Monday').from, '2026-11-09');
  assert.equal(r('last Thursday').from, '2026-11-05'); // said on a Thursday: the one before
  assert.deepEqual([r('last week').from, r('last week').to], ['2026-11-02', '2026-11-08']);
  assert.equal(r('10 Nov').from, '2026-11-10');
  assert.equal(r('November 3rd').from, '2026-11-03');
  assert.equal(r('25 Dec').from, '2025-12-25'); // not in the future
  assert.equal(r('05/11/2026').from, '2026-11-05'); // day first
  assert.equal(r('tomorrow'), null);
  // Just after midnight in Lagos is still the previous day in UTC.
  assert.equal(localDate('2026-11-11T23:30:00Z', TZ), '2026-11-12');
  assert.deepEqual(rangeToUtc({ from: '2026-11-11', to: '2026-11-11' }, TZ), { start: '2026-11-10T23:00:00.000Z', end: '2026-11-11T23:00:00.000Z' });
});

function fakeMeta(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) return new Response(JSON.stringify({ error: { message: reply.message } }), { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  };
  return { llm: createMetaClient({ apiKey: 'k', baseUrl: 'https://meta.test/v1', model: 'test-model', fetchImpl }), calls };
}

test('uses the Meta model when configured, and validates what it returns', async () => {
  const { llm, calls } = fakeMeta(
    '```json\n{"amount": 50, "currency": "usd", "counterparty": "musa", "date_phrase": "yesterday", "date_from": null, "date_to": null, "complaint_type": "RECIPIENT_NOT_CREDITED", "channel": "nonsense", "summary": "Customer says Musa did not receive $50."}\n```',
  );
  const { extraction, method } = await run('i sent musa 50 yesterday he never got am', { llm });
  assert.equal(method, 'meta');
  assert.equal(calls[0].url, 'https://meta.test/v1/chat/completions');
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(extraction.amount_cents, 5000);
  assert.equal(extraction.currency, 'USD');
  assert.equal(extraction.counterparty, 'musa');
  assert.equal(extraction.date_range.from, '2026-11-11'); // our own date reading, not the model's
  assert.equal(extraction.channel, null); // invalid value dropped
});

test('ignores made-up complaint types and pronoun names from the model', async () => {
  const { llm } = fakeMeta('{"amount": "abc", "counterparty": "him", "complaint_type": "MAKE_IT_RAIN", "date_from": "2099-01-01"}');
  const { extraction } = await run('he no receive am', { llm });
  assert.equal(extraction.amount_cents, null);
  assert.equal(extraction.counterparty, null);
  assert.equal(extraction.complaint_type, 'OTHER');
  assert.equal(extraction.date_range, null);
});

test('falls back to the built-in rules if the Meta model fails', async () => {
  const { llm } = fakeMeta(new Error('model overloaded'));
  const { extraction, method, warning } = await run("I sent Musa $50 yesterday, but he hasn't received it.", { llm });
  assert.equal(method, 'rules');
  assert.match(warning, /model overloaded/);
  assert.equal(extraction.amount_cents, 5000);
});
