import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';
import { HttpError } from './util.js';

export const COOKIE_NAME = 'fp_session';
const SESSION_DAYS = 7;

export function setSessionCookie(res, userId) {
  const token = jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

const findUser = db.prepare('SELECT id, account_id, name, email, created_at FROM users WHERE id = ?');

export function requireAuth(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  try {
    const { sub } = jwt.verify(token, config.jwtSecret);
    const user = findUser.get(Number(sub));
    if (!user) return next(new HttpError(401, 'Please sign in.'));
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired. Please sign in again.'));
  }
}
