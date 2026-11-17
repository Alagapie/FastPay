// Conversation memory: which language the customer speaks and which case they are on, plus a transcript.
// No payment data is copied here: cases, payments and decisions stay in Modules 2 and 3.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      account_id TEXT PRIMARY KEY,
      language   TEXT,
      case_id    TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      case_id    TEXT,
      speaker    TEXT NOT NULL CHECK (speaker IN ('customer', 'assistant')),
      language   TEXT NOT NULL,
      text       TEXT NOT NULL,
      english    TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_by_account ON turns (account_id, id);
  `);
  const q = {
    get: db.prepare('SELECT * FROM conversations WHERE account_id = ?'),
    upsert: db.prepare(`INSERT INTO conversations (account_id, language, case_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (account_id) DO UPDATE SET language = excluded.language, case_id = excluded.case_id, updated_at = excluded.updated_at`),
    addTurn: db.prepare('INSERT INTO turns (account_id, case_id, speaker, language, text, english, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    recentReplies: db.prepare("SELECT text FROM turns WHERE account_id = ? AND speaker = 'assistant' ORDER BY id DESC LIMIT ?"),
    turns: db.prepare('SELECT speaker, language, text, english, created_at FROM turns WHERE account_id = ? AND case_id IS ? ORDER BY id DESC LIMIT ?'),
  };
  const now = () => new Date().toISOString();
  return {
    conversation: (accountId) => q.get.get(accountId) ?? { account_id: accountId, language: null, case_id: null },
    save: (accountId, { language, case_id }) => q.upsert.run(accountId, language ?? null, case_id ?? null, now()),
    addTurn: (accountId, caseId, speaker, language, text, english = null, detail = null) =>
      q.addTurn.run(accountId, caseId ?? null, speaker, language, text, english, detail ? JSON.stringify(detail) : null, now()),
    turns: (accountId, caseId, limit = 50) => q.turns.all(accountId, caseId ?? null, limit).reverse(),
    recentReplies: (accountId, limit = 10) => q.recentReplies.all(accountId, limit).map((r) => r.text),
    close: () => db.close(),
  };
}
