import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import confetti from 'canvas-confetti';
import { ArrowRight, Home, Receipt } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { money } from '../format.js';
import { usePolling } from '../usePolling.js';
import { ease, StatusGlyph } from '../components/motion.jsx';
import { CopyButton, Spinner } from '../components/ui.jsx';

const COPY = {
  TRANSFER: {
    SUCCESS: (tx) => ({
      title: 'Payment successful!',
      body: `Your payment to ${tx.counterparty.name} was successful${tx.provider === 'PAYPAL' ? ' (paid with PayPal)' : ''}.`,
    }),
    PENDING: (tx) => ({ title: 'Payment processing', body: `Your payment to ${tx.counterparty.name} is being processed.` }),
    FAILED: (tx) => ({ title: 'Payment not sent', body: tx.failure_reason || 'The payment could not be sent. No money left your balance.' }),
    REFUNDED: (tx) => ({ title: 'Payment refunded', body: `Your payment to ${tx.counterparty.name} was refunded to your balance.` }),
  },
  WITHDRAWAL: {
    SUCCESS: (tx) => ({ title: 'Cashed out!', body: `The money is in the PayPal account ${tx.external_account}.` }),
    PENDING: (tx) => ({ title: 'On its way to PayPal', body: `PayPal is processing your payout to ${tx.external_account}. This usually takes a few minutes.` }),
    FAILED: (tx) => ({ title: 'Cash out failed', body: tx.failure_reason || 'PayPal could not complete the payout.' }),
    REFUNDED: () => ({ title: 'Cash out refunded', body: 'PayPal returned the payout, so the money is back in your FastPay balance.' }),
  },
  DEPOSIT: {
    SUCCESS: () => ({ title: 'Money added!', body: 'Your FastPay balance has been topped up.' }),
    PENDING: () => ({ title: 'Deposit processing', body: 'Your deposit will appear in your balance once it completes.' }),
    FAILED: (tx) => ({ title: 'Deposit failed', body: tx.failure_reason || 'The deposit could not be completed.' }),
  },
};

function celebrate() {
  const colors = ['#6366f1', '#8b5cf6', '#10b981', '#22d3ee', '#f59e0b'];
  confetti({ particleCount: 90, spread: 75, origin: { y: 0.45 }, colors, disableForReducedMotion: true });
  setTimeout(() => confetti({ particleCount: 50, angle: 60, spread: 60, origin: { x: 0, y: 0.6 }, colors, disableForReducedMotion: true }), 200);
  setTimeout(() => confetti({ particleCount: 50, angle: 120, spread: 60, origin: { x: 1, y: 0.6 }, colors, disableForReducedMotion: true }), 350);
}

/** Outcome of a payment. Keeps polling while pending and celebrates on success. */
export function ResultPanel({ tx: initial, onAgain, againLabel }) {
  const { refreshWallet } = useAuth();
  const [tx, setTx] = useState(initial);
  const celebrated = useRef(false);

  const poll = useCallback(async () => {
    const { transaction } = await api.get(`/transactions/${initial.reference}`);
    setTx(transaction);
    if (transaction.status !== 'PENDING') refreshWallet().catch(() => {});
  }, [initial.reference, refreshWallet]);
  usePolling(poll, tx.status === 'PENDING' ? 2500 : null);

  useEffect(() => {
    if (tx.status === 'SUCCESS' && !celebrated.current) {
      celebrated.current = true;
      const t = setTimeout(celebrate, 350);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [tx.status]);

  const copy = COPY[tx.type]?.[tx.status] ?? COPY[tx.type]?.FAILED;
  const { title, body } = copy(tx);

  return (
    <motion.div className={`card result result-${tx.status.toLowerCase()}`} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, ease }}>
      <>
        <motion.div key={tx.status} className="result-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <StatusGlyph status={tx.status === 'REFUNDED' ? 'FAILED' : tx.status} />
          <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>{title}</motion.h1>
          <motion.p className="result-amount" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}>
            {money(tx.amount, tx.currency)}
          </motion.p>
          <motion.p className="muted result-text" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>{body}</motion.p>
          {tx.status === 'PENDING' && (
            <div className="result-wait"><Spinner size={14} /> Waiting for confirmation…</div>
          )}
        </motion.div>
      </>

      <motion.div className="result-ref" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>
        <span>Reference</span>
        <code>{tx.reference}</code>
        <CopyButton value={tx.reference} />
      </motion.div>

      <motion.div className="result-actions" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}>
        {onAgain && <button className="btn btn-primary btn-block btn-lg" onClick={onAgain}>{againLabel} <ArrowRight size={18} /></button>}
        <div className="row-2">
          <Link to={`/activity/${tx.reference}`} className="btn btn-soft"><Receipt size={17} /> Details</Link>
          <Link to="/" className="btn btn-soft"><Home size={17} /> Home</Link>
        </div>
      </motion.div>
    </motion.div>
  );
}
