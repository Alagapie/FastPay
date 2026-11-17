import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, inTransaction, nowIso } from '../db.js';
import { HttpError, newAccountId } from '../util.js';
import { requireAuth, setSessionCookie, clearSessionCookie } from '../auth.js';
import { config } from '../config.js';
import { walletSummary } from '../ledger.js';

const router = Router();

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const EMAIL_RE =/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  accountExists: db.prepare('SELECT 1 FROM users WHERE account_id = ?'),
  insertUser: db.prepare('INSERT INTO users (account_id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertWallet: db.prepare('INSERT INTO wallets (user_id, currency, balance, created_at) VALUES (?, ?, 0, ?)'),
};

const publicUser = (u) => ({ id: u.id, account_id: u.account_id, name: u.name, email: u.email, created_at: u.created_at });

router.post('/register', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Please enter your full name.');
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Please enter a valid email address.');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (password.length > 72) throw new HttpError(400, 'Password must be at most 72 characters.');
  if (q.byEmail.get(email)) throw new HttpError(409, 'An account with this email already exists.');

  const hash = await bcrypt.hash(password, 10);

  const userId = inTransaction(() => {
    if (q.byEmail.get(email)) throw new HttpError(409, 'An account with this email already exists.');
    let accountId;
    do accountId = newAccountId();
    while (q.accountExists.get(accountId));
    const ts = nowIso();
    const { lastInsertRowid } = q.insertUser.run(accountId, name, email, hash, ts);
    q.insertWallet.run(lastInsertRowid, config.currency, ts);
    return Number(lastInsertRowid);
  });

  setSessionCookie(res, userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ user: publicUser(user), wallet: walletSummary(userId) });
});

router.post('/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  const user = q.byEmail.get(email);
  // Compare against a dummy hash when the user doesn't exist so timing doesn't leak which emails are registered.
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Incorrect email or password.');
  setSessionCookie(res, user.id);
  res.json({ user: publicUser(user), wallet: walletSummary(user.id) });
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), wallet: walletSummary(req.user.id) });
});

export default router;
