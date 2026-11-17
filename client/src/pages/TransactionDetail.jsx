import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertTriangle, ArrowLeft, ExternalLink, Hourglass, LifeBuoy, Repeat, ShieldAlert, Undo2, X } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { dateTime, money, signedMoney, txKind, txTitle } from '../format.js';
import { Avatar, CopyButton, DisputeBadge, Spinner, StatusBadge, TxIcon } from '../components/ui.jsx';
import { ease, Rise } from '../components/motion.jsx';
import { usePolling } from '../usePolling.js';

const DISPUTE_REASON = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Says they did not receive what they paid for',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Says it was not as described',
  UNAUTHORISED: 'Says the payment was not authorised',
  CREDIT_NOT_PROCESSED: 'Expected a refund that was not processed',
  DUPLICATE_TRANSACTION: 'Says they were charged twice',
  INCORRECT_AMOUNT: 'Says the amount was wrong',
  PAYMENT_BY_OTHER_MEANS: 'Says they paid another way',
  CANCELED_RECURRING_BILLING: 'Cancelled recurring billing',
  PROBLEM_WITH_REMITTANCE: 'Problem with the payment',
  OTHER: 'Other reason',
};
const humanize = (v) => (v ? v.toLowerCase().replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()) : '-');

function fundingLabel(tx) {
  if (tx.provider === 'PAYPAL_INVOICE') return 'PayPal invoice';
  if (tx.type === 'WITHDRAWAL') return 'FastPay balance';
  if (tx.provider === 'PAYPAL') return 'PayPal';
  if (tx.provider === 'SIMULATED') return 'Test deposit (simulated)';
  return 'FastPay balance';
}

export default function TransactionDetail() {
  const { reference } = useParams();
  const { refreshWallet, config } = useAuth();
  const [tx, setTx] = useState(null);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    try {
      const { transaction } = await api.get(`/transactions/${reference}`);
      setTx((prev) => {
        if (prev?.status === 'PENDING' && transaction.status !== 'PENDING') refreshWallet().catch(() => {});
        return transaction;
      });
    } catch (err) {
      setError(err.message);
    }
  }, [reference, refreshWallet]);

  useEffect(() => { load(); }, [load]);
  usePolling(load, tx?.status === 'PENDING' ? 2500 : null);

  if (error) {
    return (
      <div className="narrow">
        <div className="card center">
          <h2>{error}</h2>
          <Link to="/activity" className="btn btn-soft">Back to activity</Link>
        </div>
      </div>
    );
  }
  if (!tx) return <div className="page-loading"><Spinner size={32} /></div>;

  const isTransfer = tx.type === 'TRANSFER';
  const isOutgoing = tx.direction === 'DEBIT';
  const isRequest = tx.provider === 'PAYPAL_INVOICE';

  const cancelRequest = async () => {
    setCancelling(true);
    try {
      const { transaction } = await api.post(`/requests/${tx.reference}/cancel`);
      setTx({ ...transaction, disputes: tx.disputes });
    } catch (err) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="narrow">
      <Link to="/activity" className="back-link"><ArrowLeft size={16} /> Activity</Link>

      <Rise className={`card detail detail-${tx.status.toLowerCase()}`}>
        <div className="detail-hero">
          <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18 }}>
            <Avatar name={tx.counterparty.name} size={72} ring icon={TxIcon({ tx, size: 30 })} />
          </motion.div>
          <p className="muted">{txTitle(tx)}</p>
          <div className={`detail-amount ${['FAILED', 'REFUNDED'].includes(tx.status) ? 'struck' : tx.direction === 'CREDIT' ? 'credit' : ''}`}>{signedMoney(tx)}</div>
          <motion.div key={tx.status} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <StatusBadge tx={tx} />
          </motion.div>
        </div>

        <Timeline tx={tx} />

        {tx.status === 'REFUNDED' && (
          <div className="alert alert-neutral">
            <div className="alert-inner"><Undo2 size={18} /><span><strong>Refunded:</strong> {tx.failure_reason}</span></div>
          </div>
        )}
        {tx.status === 'FAILED' && tx.failure_reason && (
          <div className={`alert ${isRequest ? 'alert-neutral' : 'alert-error'}`}>
            <div className="alert-inner"><AlertTriangle size={18} /><span><strong>{isRequest ? 'Closed:' : 'Not sent:'}</strong> {tx.failure_reason}</span></div>
          </div>
        )}
        {tx.disputes?.length > 0 && (
          <div className="dispute-box">
            <div className="dispute-head"><ShieldAlert size={18} /><strong>PayPal dispute</strong><DisputeBadge status={tx.disputes[0].status} /></div>
            {tx.disputes.map((d) => (
              <dl key={d.id} className="dispute-rows">
                <div><dt>Reason</dt><dd>{DISPUTE_REASON[d.reason] ?? humanize(d.reason)}</dd></div>
                <div><dt>Status</dt><dd>{humanize(d.status)}</dd></div>
                {d.amount != null && <div><dt>Disputed amount</dt><dd>{money(d.amount, d.currency || tx.currency)}</dd></div>}
                {d.outcome && <div><dt>Outcome</dt><dd>{humanize(d.outcome)}</dd></div>}
                <div><dt>Dispute ID</dt><dd><code>{d.id}</code></dd></div>
                <div><dt>Opened</dt><dd>{dateTime(d.created_at)}</dd></div>
              </dl>
            ))}
            <p className="small muted">Disputes are handled in the PayPal Resolution Center. FastPay updates this automatically.</p>
          </div>
        )}

        {isRequest && tx.status === 'PENDING' && (
          <div className="alert alert-info">
            <div className="alert-inner">
              <Hourglass size={18} />
              <span>Waiting for {tx.external_account} to pay the PayPal invoice. Your balance is credited automatically once they pay.</span>
            </div>
          </div>
        )}
        {isRequest && tx.status === 'PENDING' && tx.payment_url && (
          <div className="request-link">
            <div className="paylink-box">
              <span className="paylink-url">{tx.payment_url}</span>
              <CopyButton value={tx.payment_url} />
            </div>
            <div className="row-2">
              <a className="btn btn-soft" href={tx.payment_url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Open invoice</a>
              <button className="btn btn-danger" onClick={cancelRequest} disabled={cancelling}>
                {cancelling ? <Spinner size={15} /> : <X size={16} />} Cancel request
              </button>
            </div>
          </div>
        )}

        {tx.status === 'PENDING' && !isRequest && (
          <div className="alert alert-info">
            <div className="alert-inner">
              <Hourglass size={18} />
              <span>
                Still processing.
                {tx.expected_settlement && ` Expected by ${dateTime(tx.expected_settlement)}.`}
              </span>
            </div>
          </div>
        )}

        <dl className="receipt">
          <div><dt>Reference</dt><dd><code>{tx.reference}</code> <CopyButton value={tx.reference} /></dd></div>
          <div><dt>Type</dt><dd>{txKind(tx)}</dd></div>
          {isRequest && <div><dt>From</dt><dd>{tx.external_account}</dd></div>}
          {isTransfer && <div><dt>From</dt><dd>{tx.sender.name} <span className="muted">· {tx.sender.account_id}</span></dd></div>}
          {tx.receiver && <div><dt>To</dt><dd>{tx.receiver.name} <span className="muted">· {tx.receiver.account_id}</span></dd></div>}
          {tx.type === 'WITHDRAWAL' && <div><dt>To PayPal</dt><dd>{tx.external_account}</dd></div>}
          <div><dt>Amount</dt><dd>{money(tx.amount, tx.currency)}</dd></div>
          <div><dt>Fee</dt><dd className="free">{tx.fee ? money(tx.fee, tx.currency) : 'Free'}</dd></div>
          {(isOutgoing || tx.type === 'DEPOSIT') && <div><dt>Paid with</dt><dd>{fundingLabel(tx)}</dd></div>}
          {tx.provider_ref && (isOutgoing || tx.type === 'DEPOSIT') && (
            <div><dt>{tx.type === 'WITHDRAWAL' ? 'PayPal payout ID' : isRequest ? 'PayPal invoice ID' : 'PayPal order ID'}</dt><dd><code>{tx.provider_ref}</code></dd></div>
          )}
          {tx.note && <div><dt>Note</dt><dd>“{tx.note}”</dd></div>}
          <div><dt>Created</dt><dd>{dateTime(tx.created_at)}</dd></div>
          {isOutgoing && (
            <>
              <div><dt>{tx.provider === 'PAYPAL' && isTransfer ? 'Charged to PayPal' : 'Debited from you'}</dt><dd>{tx.debited_at ? dateTime(tx.debited_at) : <span className="muted">Not debited</span>}</dd></div>
              {tx.credited_at && (
                <div>
                  <dt>{tx.type === 'WITHDRAWAL' ? 'Paid out to PayPal' : `Sent to ${tx.counterparty.name.split(' ')[0]}`}</dt>
                  <dd>{dateTime(tx.credited_at)}</dd>
                </div>
              )}
              {tx.reversed_at && <div><dt>Returned to your balance</dt><dd>{dateTime(tx.reversed_at)}</dd></div>}
            </>
          )}
          <div><dt>{tx.status === 'FAILED' ? 'Closed' : tx.status === 'REFUNDED' ? 'Refunded' : 'Completed'}</dt><dd>{dateTime(tx.completed_at)}</dd></div>
        </dl>

        {isTransfer && isOutgoing && (
          <Link to={`/send?to=${tx.counterparty.account_id}`} className="btn btn-soft btn-block"><Repeat size={17} /> Pay {tx.counterparty.name.split(' ')[0]} again</Link>
        )}
        {config?.investigationUrl && (
          // Opens payment help with this payment already chosen; the customer still describes and confirms it there.
          <a href={`${config.investigationUrl}/?ref=${encodeURIComponent(tx.reference)}`} className="btn btn-ghost btn-block report-link">
            <LifeBuoy size={17} /> Report a problem with this payment
          </a>
        )}
      </Rise>
    </div>
  );
}

function timelineSteps(tx) {
  const start = { label: 'Initiated', at: tx.created_at, state: 'done' };
  if (tx.provider === 'PAYPAL_INVOICE') {
    const asked = { ...start, label: 'Requested' };
    const sent = { label: 'Invoice sent', state: tx.provider_ref ? 'done' : 'failed' };
    if (tx.status === 'SUCCESS') return [asked, sent, { label: 'Paid', at: tx.credited_at, state: 'done' }];
    if (tx.status === 'FAILED') return [asked, sent, { label: 'Closed', at: tx.completed_at, state: 'failed' }];
    return [asked, sent, { label: 'Awaiting payment', state: 'current' }];
  }
  if (tx.type === 'DEPOSIT') {
    return [
      start,
      { label: 'Processing', state: tx.status === 'PENDING' ? 'current' : tx.status === 'FAILED' ? 'failed' : 'done' },
      tx.status === 'FAILED'
        ? { label: 'Failed', at: tx.completed_at, state: 'failed' }
        : { label: 'Completed', at: tx.completed_at, state: tx.status === 'SUCCESS' ? 'done' : 'todo' },
    ];
  }

  const isWithdrawal = tx.type === 'WITHDRAWAL';
  const debited = Boolean(tx.debited_at) || tx.status === 'SUCCESS';
  if (!debited) return [start, { label: 'Declined', at: tx.completed_at, state: 'failed' }];

  const debit = { label: tx.provider === 'PAYPAL' && !isWithdrawal ? 'Charged' : 'Debited', at: tx.debited_at, state: 'done' };
  const creditLabel = isWithdrawal ? 'Paid out' : 'Credited';

  if (tx.credited_at || tx.status === 'SUCCESS') return [start, debit, { label: creditLabel, at: tx.credited_at ?? tx.completed_at, state: 'done' }];
  if (tx.status === 'REFUNDED') return [start, debit, { label: 'Refunded', at: tx.reversed_at, state: 'done' }];
  if (tx.status === 'FAILED') {
    const steps = [start, debit, { label: 'Failed', at: tx.completed_at, state: 'failed' }];
    if (tx.reversed_at) steps.push({ label: 'Returned', at: tx.reversed_at, state: 'done' });
    return steps;
  }
  return [start, debit, { label: isWithdrawal ? 'Paying out' : 'Crediting', state: 'current' }];
}

function Timeline({ tx }) {
  const steps = timelineSteps(tx);
  const n = steps.length;
  const lastReached = steps.reduce((acc, s, i) => (s.state !== 'todo' ? i : acc), 0);
  const progress = n > 1 ? (lastReached / (n - 1)) * 100 : 100;
  const tone = tx.status === 'REFUNDED' ? 'success' : tx.status.toLowerCase();
  return (
    <div className="timeline" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
      <div className="timeline-track" style={{ left: `${50 / n}%`, right: `${50 / n}%` }}>
        <motion.span className={`timeline-fill ${tone}`} initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 0.9, ease, delay: 0.2 }} />
      </div>
      {steps.map((s, i) => (
        <motion.div key={s.label} className={`tl-step ${s.state}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + i * 0.15 }}>
          <span className="tl-dot" />
          <strong>{s.label}</strong>
          {s.at && <small>{dateTime(s.at)}</small>}
        </motion.div>
      ))}
    </div>
  );
}
