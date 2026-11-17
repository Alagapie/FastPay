import { useState } from 'react';
import { motion } from 'framer-motion';
import { FlaskConical, Info, ShieldCheck } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { amountError, money, toCents } from '../format.js';
import { Alert, SimulationPicker, Spinner } from '../components/ui.jsx';
import { Rise } from '../components/motion.jsx';
import PayPalCheckout from '../components/PayPalCheckout.jsx';
import { ResultPanel } from './ResultPanel.jsx';

const PRESETS = ['20', '50', '100', '250', '500'];

export default function AddMoney() {
  const { wallet, config, refreshWallet } = useAuth();
  const [amount, setAmount] = useState('50');
  const [simulate, setSimulate] = useState('success');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const paypalOn = Boolean(config?.paypalClientId);
  const amountErr = amountError(amount);

  const finish = (tx) => {
    setResult(tx);
    refreshWallet().catch(() => {});
  };

  const testDeposit = async () => {
    if (amountErr) return setError(amountErr);
    setBusy(true);
    setError('');
    try {
      const { transaction } = await api.post('/deposits/simulated', { amount, simulate });
      finish(transaction);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return <div className="narrow"><ResultPanel tx={result} onAgain={() => { setResult(null); setError(''); }} againLabel="Add more money" /></div>;
  }

  return (
    <div className="narrow">
      <div className="page-head">
        <h1 className="page-title">Add money</h1>
        <p className="muted">Top up from PayPal. Current balance <strong>{money(wallet?.balance, wallet?.currency)}</strong></p>
      </div>

      <Rise className="card">
        <div className="amount-hero">
          <div className="amount-input">
            <span className="amount-currency">$</span>
            <input
              inputMode="decimal"
              placeholder="0"
              value={amount}
              style={{ width: `${Math.max(amount.length, 1) + 0.6}ch` }}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              aria-label="Amount"
            />
          </div>
          <div className="presets">
            {PRESETS.map((p) => (
              <motion.button whileTap={{ scale: 0.92 }} key={p} type="button" className={`chip ${amount === p ? 'selected' : ''}`} onClick={() => setAmount(p)}>${p}</motion.button>
            ))}
          </div>
          {amount && amountErr && <p className="field-error">{amountErr}</p>}
        </div>
        <Alert>{error}</Alert>

        {config?.simulationEnabled && (
          <SimulationPicker
            allowed={paypalOn ? ['success', 'fail'] : ['success', 'pending', 'pending_fail', 'fail']}
            value={simulate}
            onChange={setSimulate}
            pendingSeconds={config.pendingSeconds}
            note={paypalOn ? '"Fails instantly" asks the PayPal Sandbox to decline the payment for real.' : undefined}
          />
        )}

        {paypalOn ? (
          <>
            <p className="section-label pay-label">Pay with PayPal or card</p>
            <PayPalCheckout
              createPath="/deposits/paypal/orders"
              payload={{ amount }}
              simulate={simulate}
              disabled={Boolean(amountErr)}
              onDone={finish}
              onError={setError}
            />
          </>
        ) : (
          <div className="notice">
            <Info size={18} />
            <div>
              <strong>PayPal isn't connected yet.</strong> Add your PayPal Sandbox keys to <code>server/.env</code> and restart the
              server to top up with PayPal. Until then you can make a test deposit.
            </div>
          </div>
        )}

        {config?.simulationEnabled && !paypalOn && (
          <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" onClick={testDeposit} disabled={busy || Boolean(amountErr)}>
            {busy ? <><Spinner light /> Processing…</> : <><FlaskConical size={18} /> Test deposit {amountErr ? '' : money(toCents(amount))}</>}
          </motion.button>
        )}
        <p className="secure-note"><ShieldCheck size={13} /> Card and bank details are handled by PayPal and never touch FastPay.</p>
      </Rise>
    </div>
  );
}
