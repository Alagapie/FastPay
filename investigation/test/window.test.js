// FastPay's read-only investigation window (server/src/routes/investigation.js): its locks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixture, TEST_SERVICE_TOKEN } from './helpers/fixture.js';

let fx, abdul, musa, abdulPayment, abdulTopUp;

before(async () => {
  fx = await createFixture();
  abdul = fx.addUser('Abdul Ishaq', 'abdul@test.dev');
  musa = fx.addUser('Musa Ibrahim', 'musa@test.dev');
  fx.fund(abdul, 10_000);
  abdulPayment = fx.ledger.transfer({ senderUserId: abdul.id, recipientUserId: musa.id, amount: 1000, simulate: 'credit_fail' }).reference;
  const row = fx.ledger.createPendingPaypalOrder({ userId: abdul.id, amount: 2000, orderId: 'ABDUL-ORDER' });
  fx.ledger.completePaypalOrder(row.id, { success: true, captureId: 'ABDUL-CAPTURE' });
  abdulTopUp = row.reference;
});
after(() => fx.close());

const raw = (p, headers = {}, method = 'GET') => fetch(`${fx.fastpayUrl}/api/investigation${p}`, { method, headers });
const asCustomer = (user, extra = {}) => ({ Authorization: `Bearer ${TEST_SERVICE_TOKEN}`, 'X-Customer-Session': fx.sessionFor(user), ...extra });

test('without the service key the window does not exist', async () => {
  assert.equal((await raw('/me')).status, 404);
  assert.equal((await raw('/me', { Authorization: 'Bearer wrong', 'X-Customer-Session': fx.sessionFor(abdul) })).status, 404);
  // A customer's own login alone is not enough either
  assert.equal((await raw('/me', { 'X-Customer-Session': fx.sessionFor(abdul) })).status, 404);
});

test('with the key but no valid customer, nothing is answered', async () => {
  assert.equal((await raw('/me', { Authorization: `Bearer ${TEST_SERVICE_TOKEN}` })).status, 401);
  assert.equal((await raw('/transactions', { Authorization: `Bearer ${TEST_SERVICE_TOKEN}`, 'X-Customer-Session': 'forged' })).status, 401);
});

test('it is read-only', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await raw('/transactions', asCustomer(abdul), method)).status, 405, method);
  }
});

test("a customer only ever gets their own records", async () => {
  const musaView = await fx.login(musa);
  // Musa can see the transfer addressed to him...
  assert.ok(await musaView.api.transaction(abdulPayment));
  // ...but not Abdul's top-up, Abdul's PayPal records, or Abdul's balance
  assert.equal(await musaView.api.transaction(abdulTopUp), null);
  assert.ok(!(await musaView.api.transactions()).some((t) => t.reference === abdulTopUp));
  const pp = await musaView.api.paypal.getCapture('ABDUL-CAPTURE');
  assert.equal(pp.ok, false);
  assert.match(pp.error, /Not one of this customer's payments/);
  const musaBalance = await musaView.api.reconcileWallet();
  assert.equal(musaBalance.recorded_balance, 0); // his own wallet, not Abdul's
});

test('test-mode fields are never handed out', async () => {
  const tx = await (await fx.login(abdul)).api.transaction(abdulPayment);
  for (const k of ['scheduled_outcome', 'settle_at', 'failure_reason', 'idempotency_key', 'password_hash']) assert.equal(k in tx, false, k);
});

test('the investigation module has no database access and no PayPal keys of its own', () => {
  const src = path.resolve(import.meta.dirname, '../src');
  const files = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(src, f), 'utf8'));
  const all = files.join('\n');
  // No path into FastPay's server folder, no database file, no FastPay or PayPal secrets
  assert.doesNotMatch(all, /fastpay\.db|FASTPAY_DB_PATH|['"`]\.\.\/server|PAYPAL_CLIENT_SECRET|api-m\.(sandbox\.)?paypal\.com|JWT_SECRET/);
  // node:sqlite is used only for the module's own case store
  const sqliteUsers = fs.readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.js') && fs.readFileSync(path.join(src, f), 'utf8').includes("from 'node:sqlite'"));
  assert.deepEqual(sqliteUsers.map((f) => f.replaceAll('\\', '/')), ['store.js']);
});
