// The investigation module's own database (data/investigation.db). Separate from FastPay's; FastPay's is only ever read.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newId } from './util.js';

const nowIso = () => new Date().toISOString();
const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s) => (s == null ? null : JSON.parse(s));

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS cases (
      id              TEXT PRIMARY KEY,
      user_id         INTEGER NOT NULL,              -- FastPay users.id
      status          TEXT NOT NULL CHECK (status IN ('NEEDS_DETAILS', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'INVESTIGATED')),
      complaint_type  TEXT,
      extraction      TEXT,                          -- JSON: stage 1 output, merged across messages
      excluded_refs   TEXT NOT NULL DEFAULT '[]',    -- JSON: references the customer said are not the one
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_user ON cases(user_id, created_at);

    CREATE TABLE IF NOT EXISTS case_messages (
      id          INTEGER PRIMARY KEY,
      case_id     TEXT NOT NULL REFERENCES cases(id),
      role        TEXT NOT NULL CHECK (role IN ('customer', 'support')),
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    -- Transactions shown to the customer. Only an active one can be confirmed.
    CREATE TABLE IF NOT EXISTS case_candidates (
      case_id     TEXT NOT NULL REFERENCES cases(id),
      reference   TEXT NOT NULL,
      rank        INTEGER NOT NULL,
      score       INTEGER NOT NULL,
      reasons     TEXT NOT NULL,
      display     TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      shown_at    TEXT NOT NULL,
      PRIMARY KEY (case_id, reference)
    );

    -- Stage 3. One per case: the investigation refuses to run without it.
    CREATE TABLE IF NOT EXISTS confirmations (
      case_id       TEXT PRIMARY KEY REFERENCES cases(id),
      reference     TEXT NOT NULL,
      user_id       INTEGER NOT NULL,
      confirmed_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id                TEXT PRIMARY KEY,
      case_id           TEXT NOT NULL REFERENCES cases(id),
      reference         TEXT NOT NULL,
      finding           TEXT NOT NULL,
      claim_assessment  TEXT NOT NULL,
      body              TEXT NOT NULL,                -- JSON: the full report
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_case ON reports(case_id, created_at);

    -- Suspected incidents: the same broken step on the same channel, hitting many customers.
    -- A FLAG for the team to confirm; only the team closes it.
    CREATE TABLE IF NOT EXISTS incidents (
      id            TEXT PRIMARY KEY,
      signature     TEXT NOT NULL,                 -- kind:stage:type:provider
      status        TEXT NOT NULL CHECK (status IN ('SUSPECTED', 'CONFIRMED', 'CLOSED')),
      title         TEXT NOT NULL,
      likely_bug    INTEGER NOT NULL DEFAULT 0,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      last_signals  TEXT NOT NULL                  -- JSON: counts only
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_sig ON incidents(signature, status, last_seen);
    CREATE TABLE IF NOT EXISTS incident_cases (
      incident_id  TEXT NOT NULL REFERENCES incidents(id),
      case_id      TEXT NOT NULL REFERENCES cases(id),
      linked_at    TEXT NOT NULL,
      PRIMARY KEY (incident_id, case_id)
    );

    -- Exceptions: a case staff must act on (records disagree, money not delivered, or stuck pending).
    -- One per case, with an owner and an escalation time. Re-investigating updates or closes it.
    CREATE TABLE IF NOT EXISTS exceptions (
      id               TEXT PRIMARY KEY,
      case_id          TEXT NOT NULL UNIQUE REFERENCES cases(id),
      reference        TEXT NOT NULL,
      finding          TEXT NOT NULL,
      reason           TEXT NOT NULL,
      amount_at_issue  INTEGER NOT NULL,
      currency         TEXT NOT NULL,
      owner            TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
      opened_at        TEXT NOT NULL,
      escalate_at      TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      closed_at        TEXT,
      closed_reason    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exceptions_status ON exceptions(status, escalate_at);

    -- Append-only record of everything that happened on a case.
    CREATE TABLE IF NOT EXISTS audit_log (
      id       INTEGER PRIMARY KEY,
      case_id  TEXT,
      actor    TEXT NOT NULL,                         -- customer:<user id> | system
      event    TEXT NOT NULL,
      detail   TEXT,
      at       TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);

  // Added later: the payment a case was opened from in the FastPay app (JSON { reference, display }).
  if (!db.prepare('PRAGMA table_info(cases)').all().some((c) => c.name === 'pinned')) db.exec('ALTER TABLE cases ADD COLUMN pinned TEXT');

  const q = {
    insertCase: db.prepare(`INSERT INTO cases (id, user_id, status, pinned, created_at, updated_at) VALUES (?, ?, 'NEEDS_DETAILS', ?, ?, ?)`),
    getCase: db.prepare('SELECT * FROM cases WHERE id = ?'),
    casesForUser: db.prepare('SELECT * FROM cases WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'),
    recentCases: db.prepare('SELECT * FROM cases ORDER BY created_at DESC LIMIT ?'),
    updateCase: db.prepare('UPDATE cases SET status = ?, complaint_type = ?, extraction = ?, excluded_refs = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?'),
    addMessage: db.prepare('INSERT INTO case_messages (case_id, role, body, created_at) VALUES (?, ?, ?, ?)'),
    messages: db.prepare('SELECT role, body, created_at FROM case_messages WHERE case_id = ? ORDER BY id'),
    deactivate: db.prepare('UPDATE case_candidates SET active = 0 WHERE case_id = ?'),
    upsertCandidate: db.prepare(`
      INSERT INTO case_candidates (case_id, reference, rank, score, reasons, display, active, shown_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(case_id, reference) DO UPDATE SET rank = excluded.rank, score = excluded.score, reasons = excluded.reasons,
        display = excluded.display, active = 1, shown_at = excluded.shown_at`),
    activeCandidates: db.prepare('SELECT * FROM case_candidates WHERE case_id = ? AND active = 1 ORDER BY rank'),
    insertConfirmation: db.prepare('INSERT INTO confirmations (case_id, reference, user_id, confirmed_at) VALUES (?, ?, ?, ?)'),
    confirmation: db.prepare('SELECT * FROM confirmations WHERE case_id = ?'),
    insertReport: db.prepare('INSERT INTO reports (id, case_id, reference, finding, claim_assessment, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    latestReport: db.prepare('SELECT body FROM reports WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    openIncident: db.prepare("SELECT * FROM incidents WHERE signature = ? AND status <> 'CLOSED' AND last_seen >= ? ORDER BY last_seen DESC LIMIT 1"),
    insertIncident: db.prepare("INSERT INTO incidents (id, signature, status, title, likely_bug, first_seen, last_seen, last_signals) VALUES (?, ?, 'SUSPECTED', ?, ?, ?, ?, ?)"),
    touchIncident: db.prepare('UPDATE incidents SET last_seen = ?, last_signals = ? WHERE id = ?'),
    linkCase: db.prepare('INSERT OR IGNORE INTO incident_cases (incident_id, case_id, linked_at) VALUES (?, ?, ?)'),
    incidentCases: db.prepare('SELECT case_id, linked_at FROM incident_cases WHERE incident_id = ? ORDER BY linked_at'),
    incidents: db.prepare('SELECT i.*, (SELECT COUNT(*) FROM incident_cases c WHERE c.incident_id = i.id) AS case_count FROM incidents i ORDER BY last_seen DESC LIMIT ?'),
    incident: db.prepare('SELECT i.*, (SELECT COUNT(*) FROM incident_cases c WHERE c.incident_id = i.id) AS case_count FROM incidents i WHERE id = ?'),
    exceptionFor: db.prepare('SELECT * FROM exceptions WHERE case_id = ?'),
    insertException: db.prepare(`INSERT INTO exceptions (id, case_id, reference, finding, reason, amount_at_issue, currency, owner, status, opened_at, escalate_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`),
    updateException: db.prepare(`UPDATE exceptions SET finding = ?, reason = ?, amount_at_issue = ?, status = 'OPEN', escalate_at = ?, updated_at = ?,
      closed_at = NULL, closed_reason = NULL WHERE case_id = ?`),
    closeException: db.prepare("UPDATE exceptions SET status = 'CLOSED', closed_at = ?, closed_reason = ?, updated_at = ? WHERE case_id = ? AND status = 'OPEN'"),
    exceptions: db.prepare("SELECT * FROM exceptions WHERE (? = 'ALL' OR status = ?) ORDER BY escalate_at LIMIT ?"),
    audit: db.prepare('INSERT INTO audit_log (case_id, actor, event, detail, at) VALUES (?, ?, ?, ?, ?)'),
    auditFor: db.prepare('SELECT actor, event, detail, at FROM audit_log WHERE case_id = ? ORDER BY id'),
  };

  const incidentRow = (r) => r && { ...r, likely_bug: Boolean(r.likely_bug), last_signals: parse(r.last_signals) };
  // Aging is worked out when read, so it is always current.
  const exceptionRow = (r, at = new Date()) => r && {
    ...r,
    age_minutes: Math.max(0, Math.round((at - new Date(r.opened_at)) / 60_000)),
    overdue: r.status === 'OPEN' && at >= new Date(r.escalate_at),
  };
  const caseRow = (r) => r && { ...r, extraction: parse(r.extraction), excluded_refs: parse(r.excluded_refs) ?? [], pinned: parse(r.pinned) };

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

  return {
    transaction,
    /** `pinned`: { reference, display } when the customer opened help from a payment in the FastPay app. */
    createCase(userId, pinned = null) {
      const id = newId('CASE');
      const ts = nowIso();
      q.insertCase.run(id, userId, json(pinned), ts, ts);
      return caseRow(q.getCase.get(id));
    },
    getCase: (id) => caseRow(q.getCase.get(String(id))),
    casesForUser: (userId, limit = 20) => q.casesForUser.all(userId, limit).map(caseRow),
    recentCases: (limit = 50) => q.recentCases.all(limit).map(caseRow),
    updateCase(id, { status, complaint_type, extraction, excluded_refs }) {
      q.updateCase.run(status, complaint_type ?? null, json(extraction), json(excluded_refs ?? []), nowIso(), id);
    },
    setStatus: (id, status) => q.setStatus.run(status, nowIso(), id),
    addMessage: (caseId, role, body) => q.addMessage.run(caseId, role, body, nowIso()),
    messages: (caseId) => q.messages.all(caseId).map((m) => ({ ...m })),
    setCandidates(caseId, candidates) {
      q.deactivate.run(caseId);
      const ts = nowIso();
      candidates.forEach((c, i) => q.upsertCandidate.run(caseId, c.reference, i + 1, c.score, json(c.reasons), json(c.display), ts));
    },
    clearCandidates: (caseId) => q.deactivate.run(caseId),
    activeCandidates: (caseId) =>
      q.activeCandidates.all(caseId).map((r) => ({ reference: r.reference, rank: r.rank, score: r.score, reasons: parse(r.reasons), display: parse(r.display) })),
    confirm: (caseId, reference, userId) => q.insertConfirmation.run(caseId, reference, userId, nowIso()),
    confirmation: (caseId) => {
      const r = q.confirmation.get(caseId);
      return r ? { ...r } : null;
    },
    saveReport(report) {
      q.insertReport.run(report.report_id, report.case_id, report.transaction.reference, report.finding.code, report.claim_assessment.result,
        json(report), report.generated_at);
    },
    latestReport: (caseId) => parse(q.latestReport.get(caseId)?.body ?? null),
    /** Link a case to the open incident with this signature (seen in the last 6 hours), or open one. */
    linkIncident({ caseId, signature, title, likelyBug, signals }) {
      return transaction(() => {
        const ts = nowIso();
        const since = new Date(Date.now() - 6 * 3600_000).toISOString();
        let inc = q.openIncident.get(signature, since);
        if (inc) q.touchIncident.run(ts, json(signals), inc.id);
        else {
          const id = newId('INC');
          q.insertIncident.run(id, signature, title, likelyBug ? 1 : 0, ts, ts, json(signals));
          inc = q.openIncident.get(signature, since);
        }
        q.linkCase.run(inc.id, caseId, ts);
        return incidentRow(q.incident.get(inc.id));
      });
    },
    incidents: (limit = 50) => q.incidents.all(limit).map(incidentRow),
    incident: (id) => {
      const r = q.incident.get(String(id));
      return r ? { ...incidentRow(r), cases: q.incidentCases.all(r.id).map((x) => ({ ...x })) } : null;
    },
    /** Open (or refresh) the case's exception. The first opening time is kept, so aging is honest. */
    openException({ caseId, reference, finding, reason, amount, currency, owner, escalateAt, now = new Date() }) {
      const ts = now.toISOString();
      const existing = q.exceptionFor.get(caseId);
      if (existing) q.updateException.run(finding, reason, amount, existing.status === 'OPEN' ? existing.escalate_at : escalateAt, ts, caseId);
      else q.insertException.run(newId('EXC', now), caseId, reference, finding, reason, amount, currency, owner, ts, escalateAt, ts);
      return exceptionRow(q.exceptionFor.get(caseId), now);
    },
    closeException(caseId, reason, now = new Date()) {
      const ts = now.toISOString();
      q.closeException.run(ts, reason, ts, caseId);
      return exceptionRow(q.exceptionFor.get(caseId), now);
    },
    exception: (caseId, now = new Date()) => exceptionRow(q.exceptionFor.get(caseId), now) ?? null,
    exceptions: (status = 'OPEN', limit = 100, now = new Date()) => q.exceptions.all(status, status, limit).map((r) => exceptionRow(r, now)),
    audit: (caseId, actor, event, detail) => q.audit.run(caseId ?? null, actor, event, json(detail), nowIso()),
    auditFor: (caseId) => q.auditFor.all(caseId).map((r) => ({ ...r, detail: parse(r.detail) })),
    close: () => db.close(),
  };
}
