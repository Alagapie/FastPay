import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Hash, Link2, Mail, Share2 } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { money } from '../format.js';
import { CopyButton, SkeletonList, TxList } from '../components/ui.jsx';
import { Rise } from '../components/motion.jsx';
import { usePolling } from '../usePolling.js';
import RequestMoney from '../components/RequestMoney.jsx';

export default function Receive() {
  const { user, wallet, refreshWallet } = useAuth();
  const [received, setReceived] = useState(null);
  const [requestAmount, setRequestAmount] = useState('');

  const load = useCallback(async () => {
    const [{ items }] = await Promise.all([api.get('/transactions?filter=received&limit=10'), refreshWallet()]);
    setReceived(items);
  }, [refreshWallet]);

  useEffect(() => { load().catch(() => {}); }, [load]);
  usePolling(() => load().catch(() => {}), 5000);

  const validAmount = /^\d+(\.\d{1,2})?$/.test(requestAmount) && Number(requestAmount) > 0;
  const link = `${window.location.origin}/send?to=${user.account_id}${validAmount ? `&amount=${requestAmount}` : ''}`;

  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Pay me on FastPay', text: `Pay ${user.name} on FastPay`, url: link }); } catch { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(link); } catch { /* ignore */ }
    }
  };

  return (
    <div className="narrow">
      <div className="page-head">
        <h1 className="page-title">Receive money</h1>
        <p className="muted">Share your QR code or details with anyone on FastPay.</p>
      </div>

      <Rise className="card receive-card">
        <div className="qr-frame">
          <motion.div className="qr-glow" animate={{ rotate: 360 }} transition={{ duration: 8, repeat: Infinity, ease: 'linear' }} />
          <motion.div className="qr-inner" key={link} initial={{ scale: 0.92, opacity: 0.4 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 22 }}>
            <QRCodeSVG value={link} size={176} level="M" fgColor="#1e1b4b" />
          </motion.div>
        </div>
        <h2>{user.name}</h2>
        {validAmount && <p className="request-pill">Requesting {money(Math.round(Number(requestAmount) * 100))}</p>}

        <div className="request-input">
          <span>$</span>
          <input inputMode="decimal" placeholder="Request an amount (optional)" value={requestAmount} onChange={(e) => setRequestAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </div>

        <div className="id-tiles">
          <div className="id-tile">
            <span className="id-icon"><Hash size={16} /></span>
            <div><small>Account ID</small><strong>{user.account_id}</strong></div>
            <CopyButton value={user.account_id} />
          </div>
          <div className="id-tile">
            <span className="id-icon"><Mail size={16} /></span>
            <div><small>Email</small><strong>{user.email}</strong></div>
            <CopyButton value={user.email} />
          </div>
          <div className="id-tile">
            <span className="id-icon"><Link2 size={16} /></span>
            <div><small>Payment link</small><strong className="ellipsis">{link.replace(/^https?:\/\//, '')}</strong></div>
            <CopyButton value={link} />
          </div>
        </div>
        <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" onClick={share}><Share2 size={18} /> Share payment link</motion.button>
      </Rise>

      <RequestMoney showLink />

      <Rise delay={0.15} className="card">
        <div className="card-head">
          <h2>Money received</h2>
          {wallet?.pending_incoming > 0 && <span className="badge badge-pending"><span className="badge-dot" />{money(wallet.pending_incoming)} pending</span>}
        </div>
        {received === null ? <SkeletonList rows={2} /> : <TxList items={received} empty="Nobody has paid you yet. Share your QR code above." />}
      </Rise>
    </div>
  );
}
