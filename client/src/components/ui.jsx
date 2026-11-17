import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, CheckCircle2, ChevronRight, Clock, Copy, CreditCard, FileText, FlaskConical, Landmark, ShieldAlert,
  Wallet, XCircle,
} from 'lucide-react';
import { initials, shortDate, signedMoney, txTitle } from '../format.js';
import { item, list } from './motion.jsx';

export function Logo({ light }) {
  return (
    <span className={`logo ${light ? 'logo-light' : ''}`}>
      <span className="logo-mark">
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
          <path d="M18.5 3 7 18h8l-1.5 11L25 14h-8z" fill="#fff" />
        </svg>
      </span>
      <span className="logo-text">Fast<b>Pay</b></span>
    </span>
  );
}

const GRADIENTS = [
  ['#6366f1', '#8b5cf6'], ['#ec4899', '#f43f5e'], ['#10b981', '#06b6d4'], ['#f59e0b', '#ef4444'],
  ['#3b82f6', '#06b6d4'], ['#8b5cf6', '#d946ef'], ['#14b8a6', '#22c55e'],
];

export function Avatar({ name, size = 44, icon, ring }) {
  const [a, b] = GRADIENTS[[...(name || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % GRADIENTS.length];
  return (
    <span
      className={`avatar ${icon ? 'avatar-icon' : ''} ${ring ? 'avatar-ring' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.36, background: icon ? undefined : `linear-gradient(135deg, ${a}, ${b})` }}
    >
      {icon ?? initials(name)}
    </span>
  );
}

const STATUS_LABEL = { SUCCESS: 'Successful', PENDING: 'Pending', FAILED: 'Not sent', REFUNDED: 'Refunded' };

/** Status pill. Pass `tx` (preferred) or just `status`. */
export function StatusBadge({ status, tx }) {
  const s = tx?.status ?? status;
  if (tx?.provider === 'PAYPAL_INVOICE' && s !== 'SUCCESS') {
    return (
      <span className={`badge ${s === 'PENDING' ? 'badge-pending' : 'badge-closed'}`}>
        <span className="badge-dot" />{s === 'PENDING' ? 'Awaiting payment' : 'Closed'}
      </span>
    );
  }
  return (
    <span className={`badge badge-${s.toLowerCase()}`}>
      <span className="badge-dot" />
      {STATUS_LABEL[s] ?? s}
    </span>
  );
}

export function TxIcon({ tx, size = 20 }) {
  if (tx.provider === 'PAYPAL_INVOICE') return <FileText size={size} />;
  if (tx.type === 'WITHDRAWAL') return <Wallet size={size} />;
  if (tx.type === 'DEPOSIT') return tx.provider === 'PAYPAL' ? <CreditCard size={size} /> : <Landmark size={size} />;
  return undefined;
}

const OPEN_DISPUTE = ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW'];

export function DisputeBadge({ status }) {
  const open = OPEN_DISPUTE.includes(status);
  return (
    <span className={`badge ${open ? 'badge-dispute' : 'badge-dispute-closed'}`}>
      <ShieldAlert size={11} /> {open ? 'Disputed' : 'Dispute closed'}
    </span>
  );
}

function TxAvatar({ tx }) {
  return (
    <span className="txavatar">
      <Avatar name={tx.counterparty.name} icon={TxIcon({ tx })} />
      <span className={`txavatar-dir ${tx.direction === 'CREDIT' ? 'in' : 'out'}`}>
        {tx.direction === 'CREDIT' ? <ArrowDownLeft size={11} strokeWidth={3} /> : <ArrowUpRight size={11} strokeWidth={3} />}
      </span>
    </span>
  );
}

export function TxRow({ tx }) {
  const failed = tx.status === 'FAILED' || tx.status === 'REFUNDED';
  return (
    <motion.div variants={item} layout="position">
      <Link to={`/activity/${tx.reference}`} className="txrow">
        <TxAvatar tx={tx} />
        <div className="txrow-main">
          <div className="txrow-title">{txTitle(tx)}</div>
          <div className="txrow-sub">
            {shortDate(tx.created_at)}
            {tx.note ? ` · ${tx.note}` : ''}
          </div>
        </div>
        <div className="txrow-right">
          <div className={`txrow-amount ${failed ? 'struck' : tx.direction === 'CREDIT' ? 'credit' : ''}`}>{signedMoney(tx)}</div>
          {tx.status !== 'SUCCESS' && <StatusBadge tx={tx} />}
          {tx.dispute_status && <DisputeBadge status={tx.dispute_status} />}
        </div>
        <ChevronRight size={18} className="txrow-chevron" />
      </Link>
    </motion.div>
  );
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

export function TxList({ items, empty = 'No activity yet.', grouped = false }) {
  if (!items.length) {
    return (
      <motion.div className="empty" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
        <div className="empty-art"><Clock size={26} /></div>
        {typeof empty === 'string' ? <p>{empty}</p> : empty}
      </motion.div>
    );
  }
  if (!grouped) {
    return (
      <motion.div className="txlist" variants={list} initial="hidden" animate="show">
        {items.map((tx) => <TxRow key={tx.reference} tx={tx} />)}
      </motion.div>
    );
  }
  const groups = [];
  for (const tx of items) {
    const label = dayLabel(tx.created_at);
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(tx);
  }
  return (
    <motion.div className="txlist" variants={list} initial="hidden" animate="show">
      {groups.map((g) => (
        <div key={g.label} className="txgroup">
          <motion.div variants={item} className="txgroup-label">{g.label}</motion.div>
          {g.items.map((tx) => <TxRow key={tx.reference} tx={tx} />)}
        </div>
      ))}
    </motion.div>
  );
}

export function CopyButton({ value, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button type="button" className={`copy ${copied ? 'copied' : ''}`} onClick={copy} aria-label={`${label} ${value}`}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={copied ? 'y' : 'n'} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.15 }}>
          {copied ? <Check size={14} strokeWidth={3} /> : <Copy size={14} />}
        </motion.span>
      </AnimatePresence>
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Alert({ kind = 'error', children }) {
  return (
    <AnimatePresence>
      {children && (
        <motion.div
          className={`alert alert-${kind}`}
          role={kind === 'error' ? 'alert' : 'status'}
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 'auto', marginBottom: 16, x: kind === 'error' ? [0, -6, 6, -3, 3, 0] : 0 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="alert-inner">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Spinner({ size = 18, light }) {
  return <span className={`spinner ${light ? 'spinner-light' : ''}`} style={{ width: size, height: size }} />;
}

const SIMULATIONS = [
  { value: 'success', label: 'Instant success', icon: CheckCircle2 },
  { value: 'pending', label: 'Pending → success', icon: Clock },
  { value: 'pending_fail', label: 'Pending → failed', icon: Clock },
  { value: 'fail', label: 'Fails instantly', icon: XCircle },
  { value: 'credit_fail', label: 'Debited, not credited', icon: AlertTriangle },
];

/** `allowed` limits which outcomes are offered (e.g. PayPal can't simulate "pending"). */
export function SimulationPicker({ value, onChange, pendingSeconds, note, allowed }) {
  const options = allowed ? SIMULATIONS.filter((s) => allowed.includes(s.value)) : SIMULATIONS;
  const hint =
    value === 'credit_fail'
      ? 'The payer is debited and their receipt says Successful, but the recipient is never credited.'
      : note ?? `Pending payments settle by themselves in about ${pendingSeconds ?? 20}s.`;
  return (
    <fieldset className="simbox">
      <legend><FlaskConical size={14} /> Test mode · choose the outcome</legend>
      <div className="simbox-options">
        {options.map(({ value: v, label, icon: Icon }) => (
          <label key={v} className={`sim-${v} ${value === v ? 'selected' : ''}`}>
            <input type="radio" name="simulate" value={v} checked={value === v} onChange={() => onChange(v)} />
            <Icon size={16} />
            <span>{label}</span>
            {value === v && <motion.span layoutId="sim-pill" className="sim-pill-bg" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
          </label>
        ))}
      </div>
      <p className="simbox-hint">{hint}</p>
    </fieldset>
  );
}

export function SkeletonList({ rows = 3 }) {
  return (
    <div className="skeleton-list">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row"><span className="sk-circle" /><span className="sk-lines"><i /><i /></span></div>
      ))}
    </div>
  );
}
