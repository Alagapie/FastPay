// Module 3's own database (resolution/data/resolution.db).
//
//   authorizations  one per offered money option: the exact frozen terms, who must approve, who did
//   resolutions     the action that ran. UNIQUE per transaction reference: that is the idempotency key,
//                   so a payment can be credited OR refunded OR returned, once, never two of them
//   sim_ledger      the simulated wallet credits / PayPal refunds (v1). UNIQUE idempotency key
//   audit           append-only and hash-chained: every row includes the previous row's hash
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => (s == null ? null : JSON.parse(s));
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS plans (
      case_id      TEXT PRIMARY KEY,
      report_id    TEXT NOT NULL,
      reference    TEXT NOT NULL,
      user_id      INTEGER NOT NULL,
      decision     TEXT NOT NULL,                 -- JSON: Case Evaluator output
      plan         TEXT,                          -- JSON: Resolution Planner output
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorizations (
      id                TEXT PRIMARY KEY,
      case_id           TEXT NOT NULL,
      report_id         TEXT NOT NULL,
      user_id           INTEGER NOT NULL,
      reference         TEXT NOT NULL,          -- the transaction the action is about
      action            TEXT NOT NULL CHECK (action IN ('CREDIT_WALLET', 'REFUND_PAYPAL', 'RETURN_TO_WALLET')),
      amount            INTEGER NOT NULL CHECK (amount > 0),
      currency          TEXT NOT NULL,
      target            TEXT NOT NULL,          -- JSON
      terms_hash        TEXT NOT NULL,          -- sha256 of the exact terms above
      kind              TEXT NOT NULL CHECK (kind IN ('CUSTOMER_CHOICE', 'POLICY')),
      rule              TEXT NOT NULL,
      needs_customer    INTEGER NOT NULL,
      needs_staff       INTEGER NOT NULL,
      customer_approved_at TEXT,
      staff_approved_by TEXT,
      staff_approved_at TEXT,
      status            TEXT NOT NULL CHECK (status IN ('OFFERED', 'CONFIRMING', 'APPROVED', 'CONSUMED', 'CANCELLED', 'EXPIRED')),
      status_reason     TEXT,
      expires_at        TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_case ON authorizations(case_id, status);

    CREATE TABLE IF NOT EXISTS resolutions (
      id               TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,     -- resolve:<transaction reference>
      reference        TEXT NOT NULL UNIQUE,
      case_id          TEXT NOT NULL,
      authorization_id TEXT NOT NULL UNIQUE REFERENCES authorizations(id),
      action           TEXT NOT NULL,
      amount           INTEGER NOT NULL,
      currency         TEXT NOT NULL,
      target           TEXT NOT NULL,
      authorized_by    TEXT NOT NULL,           -- customer:<id> | policy:<rule> (+ staff:<name>)
      status           TEXT NOT NULL CHECK (status IN ('EXECUTING', 'VERIFIED', 'UNVERIFIED', 'FAILED')),
      executor         TEXT NOT NULL,           -- simulated | fastpay
      execution        TEXT,                    -- JSON: executor response
      verification     TEXT,                    -- JSON
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sim_ledger (
      id               TEXT PRIMARY KEY,
      idempotency_key  TEXT NOT NULL UNIQUE,
      action           TEXT NOT NULL,
      amount           INTEGER NOT NULL,
      currency         TEXT NOT NULL,
      target           TEXT NOT NULL,
      reference        TEXT NOT NULL,
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id        INTEGER PRIMARY KEY,
      case_id   TEXT,
      actor     TEXT NOT NULL,                  -- customer:<id> | policy:<rule> | staff:<name> | agent | system
      event     TEXT NOT NULL,
      detail    TEXT,
      at        TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash      TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
  `);

  const q = {
    upsertPlan: db.prepare(`INSERT INTO plans (case_id, report_id, reference, user_id, decision, plan, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id) DO UPDATE SET report_id = excluded.report_id, reference = excluded.reference, decision = excluded.decision, plan = excluded.plan, updated_at = excluded.updated_at`),
    plan: db.prepare('SELECT * FROM plans WHERE case_id = ?'),
    insertAuth: db.prepare(`INSERT INTO authorizations (id, case_id, report_id, user_id, reference, action, amount, currency, target, terms_hash, kind, rule,
      needs_customer, needs_staff, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    auth: db.prepare('SELECT * FROM authorizations WHERE id = ?'),
    authsForCase: db.prepare('SELECT * FROM authorizations WHERE case_id = ? ORDER BY created_at, rowid'),
    setAuthStatus: db.prepare('UPDATE authorizations SET status = ?, status_reason = ?, updated_at = ? WHERE id = ? AND status = ?'),
    customerApprove: db.prepare("UPDATE authorizations SET status = 'APPROVED', customer_approved_at = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMING'"),
    staffApprove: db.prepare('UPDATE authorizations SET staff_approved_by = ?, staff_approved_at = ?, updated_at = ? WHERE id = ? AND staff_approved_at IS NULL'),
    cancelOpen: db.prepare("UPDATE authorizations SET status = 'CANCELLED', status_reason = ?, updated_at = ? WHERE case_id = ? AND status IN ('OFFERED', 'CONFIRMING', 'APPROVED')"),
    insertResolution: db.prepare(`INSERT INTO resolutions (id, idempotency_key, reference, case_id, authorization_id, action, amount, currency, target, authorized_by, status, executor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXECUTING', ?, ?, ?)`),
    finishResolution: db.prepare('UPDATE resolutions SET status = ?, execution = ?, verification = ?, updated_at = ? WHERE id = ?'),
    resolutionForRef: db.prepare('SELECT * FROM resolutions WHERE reference = ?'),
    resolutionForCase: db.prepare('SELECT * FROM resolutions WHERE case_id = ? ORDER BY created_at DESC LIMIT 1'),
    resolutions: db.prepare('SELECT * FROM resolutions ORDER BY created_at DESC LIMIT ?'),
    pendingStaff: db.prepare("SELECT * FROM authorizations WHERE needs_staff = 1 AND staff_approved_at IS NULL AND status IN ('OFFERED', 'CONFIRMING', 'APPROVED') ORDER BY created_at"),
    insertSim: db.prepare('INSERT INTO sim_ledger (id, idempotency_key, action, amount, currency, target, reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    sim: db.prepare('SELECT * FROM sim_ledger WHERE idempotency_key = ?'),
    lastAudit: db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1'),
    insertAudit: db.prepare('INSERT INTO audit (case_id, actor, event, detail, at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    auditFor: db.prepare('SELECT * FROM audit WHERE case_id = ? ORDER BY id'),
    auditAll: db.prepare('SELECT * FROM audit ORDER BY id'),
  };

  const authRow = (r) => r && { ...r, target: parse(r.target), needs_customer: Boolean(r.needs_customer), needs_staff: Boolean(r.needs_staff) };
  const resRow = (r) => r && { ...r, target: parse(r.target), execution: parse(r.execution), verification: parse(r.verification) };

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const auditHash = (r) => sha256([r.prev_hash, r.case_id ?? '', r.actor, r.event, r.detail ?? '', r.at].join('|'));

  return {
    transaction,
    savePlan: ({ caseId, reportId, reference, userId, decision, plan }, at) =>
      q.upsertPlan.run(caseId, reportId, reference, userId, json(decision), json(plan), at),
    plan: (caseId) => {
      const r = q.plan.get(caseId);
      return r && { ...r, decision: parse(r.decision), plan: parse(r.plan) };
    },
    insertAuthorization(a) {
      q.insertAuth.run(a.id, a.case_id, a.report_id, a.user_id, a.reference, a.action, a.amount, a.currency, json(a.target), a.terms_hash, a.kind, a.rule,
        a.needs_customer ? 1 : 0, a.needs_staff ? 1 : 0, a.status, a.expires_at, a.created_at, a.created_at);
      return authRow(q.auth.get(a.id));
    },
    authorization: (id) => authRow(q.auth.get(String(id))),
    authorizationsFor: (caseId) => q.authsForCase.all(caseId).map(authRow),
    /** Compare-and-set: returns true only if the row was in `from`. */
    moveAuthorization: (id, from, to, reason, at) => q.setAuthStatus.run(to, reason ?? null, at, id, from).changes === 1,
    customerApprove: (id, at) => q.customerApprove.run(at, at, id).changes === 1,
    staffApprove: (id, staff, at) => q.staffApprove.run(staff, at, at, id).changes === 1,
    cancelOpen: (caseId, reason, at) => q.cancelOpen.run(reason, at, caseId).changes,
    pendingStaff: () => q.pendingStaff.all().map(authRow),
    insertResolution(r) {
      q.insertResolution.run(r.id, r.idempotency_key, r.reference, r.case_id, r.authorization_id, r.action, r.amount, r.currency, json(r.target), r.authorized_by, r.executor, r.created_at, r.created_at);
    },
    finishResolution: (id, status, execution, verification, at) => q.finishResolution.run(status, json(execution), json(verification), at, id),
    resolutionForRef: (ref) => resRow(q.resolutionForRef.get(ref)),
    resolutionForCase: (caseId) => resRow(q.resolutionForCase.get(caseId)),
    resolutions: (limit = 100) => q.resolutions.all(limit).map(resRow),
    /** Simulated ledger. Same key twice = the first entry, never a second one. */
    simPost(entry) {
      const existing = q.sim.get(entry.idempotency_key);
      if (existing) return { ...existing, target: parse(existing.target), replayed: true };
      q.insertSim.run(entry.id, entry.idempotency_key, entry.action, entry.amount, entry.currency, json(entry.target), entry.reference, entry.created_at);
      return { ...q.sim.get(entry.idempotency_key), target: entry.target, replayed: false };
    },
    simGet: (key) => {
      const r = q.sim.get(key);
      return r && { ...r, target: parse(r.target) };
    },
    audit(caseId, actor, event, detail, at = new Date().toISOString()) {
      const row = { case_id: caseId ?? null, actor, event, detail: json(detail), at, prev_hash: q.lastAudit.get()?.hash ?? 'GENESIS' };
      row.hash = auditHash(row);
      q.insertAudit.run(row.case_id, row.actor, row.event, row.detail, row.at, row.prev_hash, row.hash);
    },
    auditFor: (caseId) => q.auditFor.all(caseId).map((r) => ({ actor: r.actor, event: r.event, detail: parse(r.detail), at: r.at, hash: r.hash })),
    /** Recompute the whole chain. Any edited, inserted or removed row breaks it. */
    verifyAuditChain() {
      let prev = 'GENESIS';
      for (const r of q.auditAll.all()) {
        if (r.prev_hash !== prev || auditHash(r) !== r.hash) return { ok: false, broken_at: r.id };
        prev = r.hash;
      }
      return { ok: true };
    },
    close: () => db.close(),
  };
}
