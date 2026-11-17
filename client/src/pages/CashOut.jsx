import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Info, Mail, ShieldCheck, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { amountError, money, toCents } from '../format.js';
import { Alert, Spinner } from '../components/ui.jsx';
import { Field } from '../components/Field.jsx';
import { ease, Rise } from '../components/motion.jsx';
import { PayPalMark } from '../components/PayPalMark.jsx';
import { ResultPanel } from './ResultPanel.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CashOut() {
  const { user, wallet, config, refreshWallet } = useAuth();
  const paypalOn = Boolean(config?.paypalClientId);
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState(user.email);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const key = useRef(null);

  const balance = wallet?.balance ?? 0;
  const cents = amountError(amount) ? 0 : toCents(amount);

  const review = (e) => {
    e.preventDefault();
    const err = amountError(amount, balance) || (!EMAIL_RE.test(email.trim()) ? 'Enter the email of your PayPal account.' : null);
    if (err) return setError(err);
    setError('');
    key.current = crypto.randomUUID();
    setReviewing(true);
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const { transaction } = await api.post('/withdrawals/paypal', { amount, email: email.trim() }, { 'Idempotency-Key': key.current });
      setResult(transaction);
      refreshWallet().catch(() => {});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="narrow">
        <ResultPanel tx={result} onAgain={() => { setResult(null); setReviewing(false); setAmount(''); }} againLabel="Cash out again" />
      </div>
    );
  }

  return (
    <div className="narrow">
      <div className="page-head">
        <h1 className="page-title">Cash out</h1>
        <p className="muted">Move money from FastPay to your PayPal account.</p>
      </div>

      <Rise className="card">
        <div className="cashout-flow">
          <div className="cf-node"><span className="cf-icon fp"><Wallet size={20} /></span><small>FastPay</small><strong>{money(balance, wallet?.currency)}</strong></div>
          <div className="cf-line"><motion.span className="cf-dot" animate={{ left: ['0%', '100%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} /></div>
          <div className="cf-node"><span className="cf-icon pp"><PayPalMark size={20} /></span><small>PayPal</small><strong className="ellipsis">{email || '—'}</strong></div>
        </div>

        <Alert>{error}</Alert>

        {!paypalOn ? (
          <div className="notice">
            <Info size={18} />
            <div><strong>PayPal isn't connected yet.</strong> Cash out uses PayPal Payouts. Add your PayPal Sandbox keys to <code>server/.env</code> and restart the server.</div>
          </div>
        ) : (
          <>
            {!reviewing ? (
              <motion.form key="form" className="form" onSubmit={review} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.35, ease } }}>
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
                  <button type="button" className="chip" onClick={() => setAmount((balance / 100).toFixed(2))} disabled={!balance}>
                    Cash out everything
                  </button>
                </div>
                <Field icon={Mail} label="PayPal account email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="The money goes to the PayPal account with this email." required />
                <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" disabled={!balance}>
                  Review <ArrowRight size={18} />
                </motion.button>
                {!balance && <p className="small muted center">Your balance is empty. Add money or ask someone to pay you first.</p>}
              </motion.form>
            ) : (
              <motion.div key="review" className="form" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.35, ease } }}>
                <dl className="receipt">
                  <div><dt>Amount</dt><dd>{money(cents, wallet?.currency)}</dd></div>
                  <div><dt>To PayPal</dt><dd>{email.trim()}</dd></div>
                  <div><dt>Fee</dt><dd className="free">Free</dd></div>
                  <div><dt>Arrives</dt><dd>Usually within minutes</dd></div>
                  <div className="receipt-total"><dt>Balance after</dt><dd>{money(balance - cents, wallet?.currency)}</dd></div>
                </dl>
                <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg btn-glow" onClick={submit} disabled={busy}>
                  {busy ? <><Spinner light /> Sending to PayPal…</> : <>Cash out {money(cents)}</>}
                </motion.button>
                <button className="btn btn-ghost btn-block" onClick={() => setReviewing(false)} disabled={busy}><ArrowLeft size={17} /> Edit</button>
              </motion.div>
            )}
          </>
        )}
        <p className="secure-note"><ShieldCheck size={13} /> Sent with PayPal Payouts. If PayPal can't pay it out, the money returns to your balance.</p>
      </Rise>
    </div>
  );
}
