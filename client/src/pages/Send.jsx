import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, AtSign, Check, Lock, MessageSquare, Search, Send as SendIcon, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { amountError, money, toCents } from '../format.js';
import { Alert, Avatar, SimulationPicker, Spinner } from '../components/ui.jsx';
import { Field } from '../components/Field.jsx';
import { ease, item, list } from '../components/motion.jsx';
import PayPalCheckout from '../components/PayPalCheckout.jsx';
import { PayPalMark } from '../components/PayPalMark.jsx';
import { ResultPanel } from './ResultPanel.jsx';

const STEPS = ['Recipient', 'Amount', 'Review'];
const QUICK = ['5', '10', '25', '50', '100'];
const SIM_LABEL = {
  pending: 'Pending → success',
  pending_fail: 'Pending → failed',
  fail: 'Fails instantly',
  credit_fail: 'Debited, not credited',
};
const BALANCE_SIMS = ['success', 'pending', 'pending_fail', 'fail', 'credit_fail'];
const PAYPAL_SIMS = ['success', 'fail', 'credit_fail'];

const slide = {
  enter: (dir) => ({ opacity: 0, x: dir * 40 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.35, ease } },
};
// Steps swap instantly and slide in. No waiting for an exit animation: that could freeze and leave the card empty.

export default function Send() {
  const { wallet, config, refreshWallet } = useAuth();
  const [params] = useSearchParams();
  const paypalOn = Boolean(config?.paypalClientId);
  const [[step, dir], setStepDir] = useState([0, 1]);
  const [handle, setHandle] = useState(params.get('to') ?? '');
  const [recipient, setRecipient] = useState(null);
  const [amount, setAmount] = useState(params.get('amount') ?? '');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('balance'); // balance | paypal
  const [simulate, setSimulate] = useState('success');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [contacts, setContacts] = useState([]);
  const idempotencyKey = useRef(null);

  const go = (next) => setStepDir([next, next > step ? 1 : -1]);

  useEffect(() => {
    refreshWallet().catch(() => {});
    api.get('/transactions?filter=sent&limit=40').then(({ items }) => {
      const seen = new Map();
      for (const t of items) if (!seen.has(t.counterparty.account_id)) seen.set(t.counterparty.account_id, t.counterparty);
      setContacts([...seen.values()].slice(0, 6));
    }).catch(() => {});
  }, [refreshWallet]);

  // PayPal can't simulate "pending" outcomes; fall back to success if one was chosen.
  useEffect(() => {
    if (method === 'paypal' && !PAYPAL_SIMS.includes(simulate)) setSimulate('success');
  }, [method, simulate]);

  const lookup = async (q) => {
    setError('');
    setBusy(true);
    try {
      const { recipient } = await api.get(`/users/lookup?q=${encodeURIComponent(q.trim())}`);
      setRecipient(recipient);
      go(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (params.get('to')) lookup(params.get('to'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toReview = (e) => {
    e.preventDefault();
    // Only the balance limits a FastPay-balance payment; in test mode let the server record "insufficient funds".
    const limit = method === 'balance' && simulate === 'success' ? wallet?.balance : undefined;
    const err = amountError(amount, limit);
    if (err) return setError(err);
    setError('');
    idempotencyKey.current = crypto.randomUUID();
    go(2);
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const { transaction } = await api.post(
        '/transfers',
        { recipient: recipient.account_id, amount, note, simulate },
        { 'Idempotency-Key': idempotencyKey.current },
      );
      done(transaction);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const done = (transaction) => {
    setResult(transaction);
    refreshWallet().catch(() => {});
  };

  const reset = () => {
    setStepDir([0, -1]); setHandle(''); setRecipient(null); setAmount(''); setNote(''); setResult(null); setError(''); setSimulate('success');
  };

  const cents = useMemo(() => (amountError(amount) ? 0 : toCents(amount)), [amount]);

  if (result) {
    return <div className="narrow"><ResultPanel tx={result} onAgain={reset} againLabel="Send another" /></div>;
  }

  return (
    <div className="narrow">
      <div className="page-head">
        <h1 className="page-title">Send money</h1>
        <p className="muted">Pay anyone on FastPay from your balance or with PayPal.</p>
      </div>

      <div className="stepper">
        <div className="stepper-track"><motion.span className="stepper-fill" animate={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} transition={{ duration: 0.5, ease }} /></div>
        {STEPS.map((s, i) => (
          <div key={s} className={`stepper-step ${i === step ? 'current' : i < step ? 'done' : ''}`}>
            <motion.span className="stepper-dot" animate={{ scale: i === step ? 1.12 : 1 }}>{i + 1}</motion.span>
            <span className="stepper-label">{s}</span>
          </div>
        ))}
      </div>

      <div className="card send-card">
        <Alert>{error}</Alert>
        <>
          {step === 0 && (
            <motion.form key="s0" custom={dir} variants={slide} initial="enter" animate="center" onSubmit={(e) => { e.preventDefault(); lookup(handle); }} className="form">
              <Field
                icon={Search}
                label="Who are you paying?"
                autoFocus
                placeholder="Email or account ID, e.g. FP0123456789"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                required
              />
              {contacts.length > 0 && (
                <div>
                  <p className="section-label">Recent</p>
                  <motion.div className="contacts" variants={list} initial="hidden" animate="show">
                    {contacts.map((c) => (
                      <motion.button type="button" key={c.account_id} variants={item} whileHover={{ y: -3 }} whileTap={{ scale: 0.95 }} className="contact" onClick={() => { setHandle(c.account_id); lookup(c.account_id); }}>
                        <Avatar name={c.name} size={52} />
                        <span>{c.name.split(' ')[0]}</span>
                      </motion.button>
                    ))}
                  </motion.div>
                </div>
              )}
              <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" disabled={busy || !handle.trim()}>
                {busy ? <><Spinner light /> Finding…</> : <>Continue <ArrowRight size={18} /></>}
              </motion.button>
            </motion.form>
          )}

          {step === 1 && recipient && (
            <motion.form key="s1" custom={dir} variants={slide} initial="enter" animate="center" onSubmit={toReview} className="form">
              <RecipientCard recipient={recipient} onChange={() => { go(0); setRecipient(null); }} />
              <div className="amount-hero">
                <div className="amount-input">
                  <span className="amount-currency">$</span>
                  <input
                    autoFocus
                    inputMode="decimal"
                    placeholder="0"
                    value={amount}
                    style={{ width: `${Math.max(amount.length, 1) + 0.6}ch` }}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                    aria-label="Amount"
                  />
                </div>
                <div className="presets">
                  {QUICK.map((q) => (
                    <motion.button whileTap={{ scale: 0.92 }} key={q} type="button" className={`chip ${amount === q ? 'selected' : ''}`} onClick={() => setAmount(q)}>${q}</motion.button>
                  ))}
                </div>
              </div>

              <div>
                <p className="section-label">Pay with</p>
                <div className="methods">
                  <MethodCard
                    active={method === 'balance'}
                    onClick={() => setMethod('balance')}
                    icon={<span className="method-icon fp"><Wallet size={18} /></span>}
                    title="FastPay balance"
                    sub={`${money(wallet?.balance, wallet?.currency)} available`}
                  />
                  <MethodCard
                    active={method === 'paypal'}
                    disabled={!paypalOn}
                    onClick={() => paypalOn && setMethod('paypal')}
                    icon={<span className="method-icon pp"><PayPalMark size={18} /></span>}
                    title="PayPal"
                    sub={paypalOn ? 'PayPal account or card' : 'Not connected yet'}
                  />
                </div>
              </div>

              <Field icon={MessageSquare} label="Add a note (optional)" maxLength={140} placeholder="What's it for?" value={note} onChange={(e) => setNote(e.target.value)} />
              {config?.simulationEnabled && (
                <SimulationPicker
                  allowed={method === 'paypal' ? PAYPAL_SIMS : BALANCE_SIMS}
                  value={simulate}
                  onChange={setSimulate}
                  pendingSeconds={config.pendingSeconds}
                />
              )}
              <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg">Review <ArrowRight size={18} /></motion.button>
            </motion.form>
          )}

          {step === 2 && (
            <motion.div key="s2" custom={dir} variants={slide} initial="enter" animate="center" className="form">
              <div className="review-hero">
                <Avatar name={recipient.name} size={68} ring />
                <p className="muted">You're sending</p>
                <div className="review-amount">{money(cents, wallet?.currency)}</div>
                <p>to <strong>{recipient.name}</strong></p>
                {note && <p className="review-note">“{note}”</p>}
              </div>
              <dl className="receipt">
                <div><dt>Recipient</dt><dd>{recipient.email}</dd></div>
                <div><dt>Account ID</dt><dd>{recipient.account_id}</dd></div>
                <div><dt>Paying with</dt><dd>{method === 'paypal' ? 'PayPal' : 'FastPay balance'}</dd></div>
                <div><dt>Fee</dt><dd className="free">Free</dd></div>
                {simulate !== 'success' && <div><dt>Test outcome</dt><dd>{SIM_LABEL[simulate]}</dd></div>}
                <div className="receipt-total"><dt>Total</dt><dd>{money(cents, wallet?.currency)}</dd></div>
              </dl>

              {method === 'paypal' ? (
                <PayPalCheckout
                  createPath="/transfers/paypal/orders"
                  payload={{ amount, recipient: recipient.account_id, note }}
                  simulate={simulate}
                  onDone={done}
                  onError={setError}
                />
              ) : (
                <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg btn-glow" onClick={confirm} disabled={busy}>
                  {busy ? <><Spinner light /> Sending…</> : <><SendIcon size={18} /> Send {money(cents)}</>}
                </motion.button>
              )}
              <button className="btn btn-ghost btn-block" onClick={() => go(1)} disabled={busy}><ArrowLeft size={17} /> Edit</button>
              <p className="secure-note"><Lock size={13} /> {method === 'paypal' ? 'Checkout is handled securely by PayPal.' : "Protected by FastPay. Payments can't be sent twice."}</p>
            </motion.div>
          )}
        </>
      </div>
      <p className="center muted small">
        Want to get paid instead? <Link to="/receive"><AtSign size={13} /> Share your details</Link>
      </p>
    </div>
  );
}

function MethodCard({ active, disabled, onClick, icon, title, sub }) {
  return (
    <motion.button type="button" whileTap={disabled ? undefined : { scale: 0.97 }} className={`method ${active ? 'active' : ''}`} disabled={disabled} onClick={onClick}>
      {icon}
      <span className="method-text"><strong>{title}</strong><small>{sub}</small></span>
      <span className="method-check">{active && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}><Check size={13} strokeWidth={3} /></motion.span>}</span>
    </motion.button>
  );
}

function RecipientCard({ recipient, onChange }) {
  return (
    <motion.div className="recipient" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
      <Avatar name={recipient.name} size={46} />
      <div>
        <strong>{recipient.name}</strong>
        <span>{recipient.email} · {recipient.account_id}</span>
      </div>
      {onChange && <button type="button" className="btn-link" onClick={onChange}>Change</button>}
    </motion.div>
  );
}
