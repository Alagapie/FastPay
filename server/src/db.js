import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || path.resolve(import.meta.dirname, '..', 'data', 'fastpay.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

const TRANSACTIONS_SCHEMA = `(
    id                  INTEGER PRIMARY KEY,
    reference           TEXT NOT NULL UNIQUE,
    type                TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'TRANSFER', 'WITHDRAWAL')),
    status              TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
    amount              INTEGER NOT NULL CHECK (amount > 0),         -- in cents
    currency            TEXT NOT NULL,
    sender_wallet_id    INTEGER REFERENCES wallets(id),               -- NULL for deposits
    receiver_wallet_id  INTEGER REFERENCES wallets(id),               -- NULL for withdrawals
    note                TEXT,
    failure_reason      TEXT,
    provider            TEXT NOT NULL,                                -- FASTPAY | PAYPAL | SIMULATED
    provider_ref        TEXT,                                         -- PayPal order / capture / payout batch id
    external_account    TEXT,                                         -- PayPal email for withdrawals
    initiated_by        INTEGER NOT NULL REFERENCES users(id),
    idempotency_key     TEXT,
    settle_at           TEXT,                                         -- simulated pending settlement time
    scheduled_outcome   TEXT,                                         -- SUCCESS | FAILED | STUCK
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT,
    debited_at          TEXT,                                         -- money left the payer
    credited_at         TEXT,                                         -- money reached the payee
    reversed_at         TEXT,                                         -- money returned to the payer
    capture_id          TEXT,                                         -- PayPal capture id (used to match disputes)
    payment_url         TEXT,                                         -- PayPal invoice link for payment requests
    request_id          INTEGER,                                      -- in-app payment request this pays
    UNIQUE (initiated_by, idempotency_key)
  )`;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY,
    account_id     TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id),
    currency    TEXT NOT NULL DEFAULT 'USD',
    balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),  -- in cents
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions ${TRANSACTIONS_SCHEMA};
`);

// ---- Migrations for databases created by earlier versions -------------------
{
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  for (const col of ['debited_at', 'credited_at', 'reversed_at', 'external_account', 'capture_id', 'payment_url', 'request_id']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE transactions ADD COLUMN ${col} TEXT`);
  }

  // Older schema had no WITHDRAWAL type and a NOT NULL receiver; SQLite needs a table rebuild for that.
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'`).get();
  if (!sql.includes("'WITHDRAWAL'")) {
    const all = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name).join(', ');
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE transactions_new ${TRANSACTIONS_SCHEMA}`);
      db.exec(`INSERT INTO transactions_new (${all}) SELECT ${all} FROM transactions`);
      db.exec('DROP TABLE transactions');
      db.exec('ALTER TABLE transactions_new RENAME TO transactions');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Earlier builds auto-reversed stuck payments; they now simply stay stuck.
  db.exec(`UPDATE transactions SET scheduled_outcome = 'STUCK', settle_at = NULL WHERE scheduled_outcome = 'REVERSE'`);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tx_sender   ON transactions(sender_wallet_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tx_receiver ON transactions(receiver_wallet_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tx_pending  ON transactions(status, settle_at);
  CREATE INDEX IF NOT EXISTS idx_tx_provider ON transactions(provider, provider_ref);
  CREATE INDEX IF NOT EXISTS idx_tx_capture  ON transactions(capture_id);

  -- Every PayPal webhook we accept, so each event is processed once.
  CREATE TABLE IF NOT EXISTS webhook_events (
    id           TEXT PRIMARY KEY,
    event_type   TEXT NOT NULL,
    resource_id  TEXT,
    status       TEXT NOT NULL,          -- RECEIVED | PROCESSED | ERROR
    error        TEXT,
    received_at  TEXT NOT NULL
  );

  -- Money requests between FastPay users (shown in the payer's app). Requests to people
  -- outside FastPay are PayPal invoices, stored as PAYPAL_INVOICE transactions instead.
  CREATE TABLE IF NOT EXISTS payment_requests (
    id              INTEGER PRIMARY KEY,
    reference       TEXT NOT NULL UNIQUE,
    requester_id    INTEGER NOT NULL REFERENCES users(id),
    payer_id        INTEGER NOT NULL REFERENCES users(id),
    amount          INTEGER NOT NULL CHECK (amount > 0),
    currency        TEXT NOT NULL,
    note            TEXT,
    status          TEXT NOT NULL CHECK (status IN ('PENDING', 'PAID', 'DECLINED', 'CANCELLED')),
    paid_reference  TEXT,               -- the transaction that paid it
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_req_payer     ON payment_requests(payer_id, status);
  CREATE INDEX IF NOT EXISTS idx_req_requester ON payment_requests(requester_id, created_at);

  -- PayPal disputes raised on PayPal-funded payments.
  CREATE TABLE IF NOT EXISTS disputes (
    id              TEXT PRIMARY KEY,    -- PayPal dispute id
    transaction_id  INTEGER REFERENCES transactions(id),
    reason          TEXT,
    status          TEXT,
    outcome         TEXT,
    amount          INTEGER,
    currency        TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
`);

/** Run fn inside a write transaction; rolls back on any thrown error. */
export function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
