import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, AtSign, BellRing, FileText, MessageSquare, Send } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { amountError, money } from '../format.js';
import { Field } from './Field.jsx';
import { Alert, CopyButton, Spinner } from './ui.jsx';
import { Rise } from './motion.jsx';

/**
 * Request money.
 *  - FastPay users (email or account ID): the request appears in their app with Pay / Decline.
 *  - Anyone else (email): PayPal emails them an invoice; paying it credits your balance.
 */
export default function RequestMoney({ onCreated, showLink = false }) {
  const { config } = useAuth();
  const invoicing = Boolean(config?.paypalClientId && config?.paypalFeatures?.invoicing);
  const [form, setForm] = useState({ to: '', amount: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: k === 'amount' ? e.target.value.replace(/[^\d.]/g, '') : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    const err = amountError(form.amount);
    if (err) return setError(err);
    setBusy(true);
    setError('');
    try {
      const res = await api.post('/requests', form);
      if (res.kind === 'INVOICE' && res.transaction?.status === 'FAILED') {
        setError(res.transaction.failure_reason);
      } else {
        setDone(res);
        setForm({ to: '', amount: '', note: '' });
        onCreated?.();
      }
    } catch (err2) {
      setError(err2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Rise delay={0.1} className="card">
      <div className="card-head">
        <h2><Send size={18} /> Request money</h2>
        {showLink && <Link to="/requests?tab=sent" className="link-arrow">Your requests <ArrowRight size={15} /></Link>}
      </div>
      <p className="muted small">
        Ask a <strong>FastPay user</strong> and it appears in their app right away.
        {invoicing ? ' Ask anyone else by email and PayPal sends them an invoice they can pay with PayPal or a card.' : ''}
      </p>

      <>
        {done ? (
          <motion.div key="done" className="request-done" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
            {done.kind === 'FASTPAY' ? (
              <>
                <span className="request-done-icon"><BellRing size={20} /></span>
                <strong>Request sent to {done.request.payer.name}</strong>
                <p className="muted small">They'll see your request for {money(done.request.amount, done.request.currency)} in their FastPay app. Your balance updates when they pay.</p>
              </>
            ) : (
              <>
                <span className="request-done-icon"><FileText size={20} /></span>
                <strong>PayPal invoice sent to {done.transaction.external_account}</strong>
                <p className="muted small">
                  They'll get a request for {money(done.transaction.amount, done.transaction.currency)}.
                  {config?.paypalEnv === 'sandbox' ? ' In the PayPal Sandbox no real email is sent, so share this link with them:' : ' You can also share the link directly:'}
                </p>
                {done.transaction.payment_url && (
                  <div className="paylink-box">
                    <span className="paylink-url">{done.transaction.payment_url}</span>
                    <CopyButton value={done.transaction.payment_url} />
                  </div>
                )}
              </>
            )}
            <div className="row-2">
              <button className="btn btn-soft" onClick={() => setDone(null)}>New request</button>
              <Link className="btn btn-ghost" to="/requests?tab=sent">See all requests</Link>
            </div>
          </motion.div>
        ) : (
          <motion.form key="form" className="form" onSubmit={submit} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Alert>{error}</Alert>
            <div className="request-grid">
              <Field
                icon={AtSign}
                label="Who should pay?"
                required
                placeholder={invoicing ? 'Email or FastPay account ID' : 'FastPay email or account ID'}
                value={form.to}
                onChange={set('to')}
              />
              <Field label="Amount (USD)" inputMode="decimal" required placeholder="0.00" value={form.amount} onChange={set('amount')} />
            </div>
            <Field icon={MessageSquare} label="What's it for? (optional)" maxLength={500} placeholder="e.g. Concert tickets" value={form.note} onChange={set('note')} />
            <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block" disabled={busy}>
              {busy ? <><Spinner light /> Sending request…</> : <><Send size={17} /> Send request</>}
            </motion.button>
          </motion.form>
        )}
      </>
    </Rise>
  );
}
