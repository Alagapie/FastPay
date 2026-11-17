import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ExternalLink, FileText, Inbox, Send, Wallet, X } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { money, shortDate } from '../format.js';
import { usePolling } from '../usePolling.js';
import { useRequestCount } from '../requestCount.jsx';
import { Alert, Avatar, Spinner } from '../components/ui.jsx';
import { item, list, Rise } from '../components/motion.jsx';
import PayPalCheckout from '../components/PayPalCheckout.jsx';
import RequestMoney from '../components/RequestMoney.jsx';

const STATUS = {
  PENDING: { label: 'Waiting', cls: 'badge-pending' },
  PAID: { label: 'Paid', cls: 'badge-success' },
  DECLINED: { label: 'Declined', cls: 'badge-closed' },
  CANCELLED: { label: 'Cancelled', cls: 'badge-closed' },
};

function RequestBadge({ status }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  return <span className={`badge ${s.cls}`}><span className="badge-dot" />{s.label}</span>;
}

export default function Requests() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'sent' ? 'sent' : 'incoming';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const { refresh: refreshCount } = useRequestCount();

  const load = useCallback(async () => {
    try {
      setData(await api.get('/requests'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 8000);

  const changed = () => { load(); refreshCount(); };
  const openIncoming = data?.incoming.filter((r) => r.status === 'PENDING').length ?? 0;

  return (
    <div className="narrow">
      <div className="page-head">
        <h1 className="page-title">Requests</h1>
        <p className="muted">Money people have asked you for, and money you've asked for.</p>
      </div>

      <div className="tabs tabs-wide" role="tablist">
        {[['incoming', `For you${openIncoming ? ` (${openIncoming})` : ''}`], ['sent', 'Sent by you']].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setParams(key === 'sent' ? { tab: 'sent' } : {}, { replace: true })}>
            {tab === key && <motion.span layoutId="req-tab" className="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <span>{label}</span>
          </button>
        ))}
      </div>

      {error && <Alert>{error}</Alert>}

      {tab === 'incoming' ? (
        <Rise className="card">
          {data === null ? (
            <div className="center pad"><Spinner size={26} /></div>
          ) : data.incoming.length === 0 ? (
            <div className="empty"><div className="empty-art"><Inbox size={26} /></div><p>No one has asked you for money yet.</p></div>
          ) : (
            <motion.div className="req-list" variants={list} initial="hidden" animate="show">
              {data.incoming.map((r) => <IncomingRequest key={r.reference} r={r} onChange={changed} />)}
            </motion.div>
          )}
        </Rise>
      ) : (
        <>
          <RequestMoney onCreated={changed} />
          <Rise delay={0.1} className="card">
            <div className="card-head"><h2>Sent by you</h2></div>
            {data === null ? (
              <div className="center pad"><Spinner size={26} /></div>
            ) : data.outgoing.length === 0 ? (
              <p className="muted">You haven't requested money yet.</p>
            ) : (
              <motion.div className="req-list" variants={list} initial="hidden" animate="show">
                {data.outgoing.map((r) => <OutgoingRequest key={r.reference} r={r} onChange={changed} />)}
              </motion.div>
            )}
          </Rise>
        </>
      )}
    </div>
  );
}

function IncomingRequest({ r, onChange }) {
  const { wallet, config, refreshWallet } = useAuth();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [paypalOpen, setPaypalOpen] = useState(false);
  const [paid, setPaid] = useState(null);
  const open = r.status === 'PENDING';
  const canBalance = (wallet?.balance ?? 0) >= r.amount;

  const act = async (kind) => {
    setBusy(kind);
    setError('');
    try {
      if (kind === 'pay') {
        const { transaction } = await api.post(`/requests/${r.reference}/pay`);
        setPaid(transaction);
        refreshWallet().catch(() => {});
      } else {
        await api.post(`/requests/${r.reference}/decline`);
      }
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const paidWithPayPal = (transaction) => {
    setPaypalOpen(false);
    if (transaction.status === 'SUCCESS') setPaid(transaction);
    else setError(transaction.failure_reason || 'The PayPal payment did not complete.');
    refreshWallet().catch(() => {});
    onChange();
  };

  return (
    <motion.div variants={item} className={`req ${open ? 'req-open' : ''}`}>
      <div className="req-top">
        <Avatar name={r.requester.name} size={46} />
        <div className="req-main">
          <strong>{r.requester.name} requested {money(r.amount, r.currency)}</strong>
          <small>{shortDate(r.created_at)}{r.note ? ` · “${r.note}”` : ''}{r.kind === 'INVOICE' ? ' · PayPal invoice' : ''}</small>
        </div>
        <RequestBadge status={paid ? 'PAID' : r.status} />
      </div>

      <AnimatePresence>
        {paid && (
          <motion.div className="req-paid" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
            <Check size={16} strokeWidth={3} /> You paid {money(paid.amount, paid.currency)} to {r.requester.name}.
            <Link to={`/activity/${paid.reference}`} className="btn-link">View receipt</Link>
          </motion.div>
        )}
      </AnimatePresence>
      {error && <p className="field-error">{error}</p>}

      {open && !paid && r.kind === 'FASTPAY' && (
        <>
          <div className="req-actions">
            <motion.button whileTap={{ scale: 0.97 }} className="btn btn-primary" disabled={!!busy || !canBalance} onClick={() => act('pay')} title={canBalance ? '' : 'Not enough balance'}>
              {busy === 'pay' ? <Spinner size={15} light /> : <Wallet size={16} />} Pay {money(r.amount)}
            </motion.button>
            {config?.paypalClientId && (
              <button className={`btn ${paypalOpen ? 'btn-soft active' : 'btn-soft'}`} disabled={!!busy} onClick={() => setPaypalOpen((o) => !o)}>
                Pay with PayPal
              </button>
            )}
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => act('decline')}>
              {busy === 'decline' ? <Spinner size={15} /> : <X size={16} />} Decline
            </button>
          </div>
          {!canBalance && <p className="small muted">Your balance ({money(wallet?.balance)}) isn't enough. Pay with PayPal or add money first.</p>}
          <AnimatePresence>
            {paypalOpen && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
                <PayPalCheckout
                  createPath={`/requests/${r.reference}/paypal/orders`}
                  payload={{ amount: (r.amount / 100).toFixed(2) }}
                  onDone={paidWithPayPal}
                  onError={setError}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {open && r.kind === 'INVOICE' && r.payment_url && (
        <div className="req-actions">
          <a className="btn btn-primary" href={r.payment_url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Pay invoice on PayPal</a>
          <span className="small muted">This request was sent as a PayPal invoice.</span>
        </div>
      )}
    </motion.div>
  );
}

function OutgoingRequest({ r, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = async () => {
    setBusy(true);
    try {
      await api.post(`/requests/${r.reference}/cancel`);
      onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div variants={item} className="req">
      <div className="req-top">
        <Avatar name={r.payer.name} size={42} icon={r.kind === 'INVOICE' ? <FileText size={18} /> : undefined} />
        <div className="req-main">
          <strong>{money(r.amount, r.currency)} from {r.payer.name}</strong>
          <small>
            {shortDate(r.created_at)}{r.note ? ` · “${r.note}”` : ''} · {r.kind === 'INVOICE' ? 'PayPal invoice' : 'In FastPay'}
          </small>
        </div>
        <RequestBadge status={r.status} />
      </div>
      {r.failure_reason && r.status !== 'PAID' && <p className="small muted">{r.failure_reason}</p>}
      {error && <p className="field-error">{error}</p>}
      {r.status === 'PENDING' && (
        <div className="req-actions">
          {r.kind === 'INVOICE' && r.payment_url && (
            <a className="btn btn-soft" href={r.payment_url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Invoice link</a>
          )}
          <button className="btn btn-ghost" onClick={cancel} disabled={busy}>{busy ? <Spinner size={15} /> : <X size={15} />} Cancel</button>
        </div>
      )}
      {r.status === 'PAID' && r.paid_reference && (
        <Link to={`/activity/${r.paid_reference}`} className="btn-link"><Send size={13} /> View payment</Link>
      )}
    </motion.div>
  );
}
