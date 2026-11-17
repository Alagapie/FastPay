import { useState } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { Eye, EyeOff, Hourglass, Zap } from 'lucide-react';
import { money } from '../format.js';
import { AnimatedMoney, ease } from './motion.jsx';
import { CopyButton } from './ui.jsx';

/** The gradient "card" showing the wallet balance. Tilts gently toward the cursor. */
export default function WalletCard({ user, wallet }) {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem('fp_hide_balance') === '1'; } catch { return false; }
  });
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const rotateX = useSpring(useTransform(my, [0, 1], [7, -7]), { stiffness: 200, damping: 20 });
  const rotateY = useSpring(useTransform(mx, [0, 1], [-9, 9]), { stiffness: 200, damping: 20 });
  const glareX = useTransform(mx, [0, 1], ['0%', '100%']);
  const glareY = useTransform(my, [0, 1], ['0%', '100%']);

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    mx.set((e.clientX - r.left) / r.width);
    my.set((e.clientY - r.top) / r.height);
  };
  const onLeave = () => { mx.set(0.5); my.set(0.5); };

  const toggle = () => {
    setHidden((h) => {
      try { localStorage.setItem('fp_hide_balance', h ? '0' : '1'); } catch { /* ignore */ }
      return !h;
    });
  };

  const pendingIn = wallet?.pending_incoming ?? 0;

  return (
    <motion.div className="wallet-stage" initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.7, ease }}>
      <motion.div className="wallet-card" style={{ rotateX, rotateY, transformPerspective: 1000 }} onMouseMove={onMove} onMouseLeave={onLeave}>
        <span className="wc-blob a" />
        <span className="wc-blob b" />
        <span className="wc-sheen" />
        <motion.span className="wc-glare" style={{ '--gx': glareX, '--gy': glareY }} />

        <div className="wc-top">
          <span className="wc-label">Available balance</span>
          <button className="wc-eye" onClick={toggle} aria-label={hidden ? 'Show balance' : 'Hide balance'}>
            {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
        <div className="wc-amount"><AnimatedMoney cents={wallet?.balance ?? 0} currency={wallet?.currency} hidden={hidden} /></div>

        {pendingIn > 0 && (
          <motion.div className="wc-pending" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <Hourglass size={14} />
            <span>{money(pendingIn)} incoming</span>
          </motion.div>
        )}

        <div className="wc-bottom">
          <div>
            <span className="wc-small">Account ID</span>
            <span className="wc-id">{user.account_id.replace(/(FP)(\d{2})(\d{4})(\d{4})/, '$1 $2 $3 $4')}</span>
          </div>
          <div className="wc-brand">
            <Zap size={16} fill="currentColor" />
            <span>{wallet?.currency ?? 'USD'}</span>
          </div>
        </div>
        <div className="wc-copy"><CopyButton value={user.account_id} label="Copy ID" /></div>
      </motion.div>
    </motion.div>
  );
}
