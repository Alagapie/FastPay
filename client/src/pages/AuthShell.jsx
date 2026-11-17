import { motion } from 'framer-motion';
import { ArrowDownLeft, Check, ShieldCheck, Zap } from 'lucide-react';
import { Logo } from '../components/ui.jsx';
import { ease } from '../components/motion.jsx';

const float = (delay, distance = 12) => ({
  animate: { y: [0, -distance, 0] },
  transition: { duration: 6, repeat: Infinity, ease: 'easeInOut', delay },
});

export default function AuthShell({ title, subtitle, children }) {
  return (
    <div className="auth">
      <aside className="auth-hero">
        <div className="hero-blob b1" />
        <div className="hero-blob b2" />
        <div className="hero-blob b3" />
        <div className="hero-grid" />

        <div className="hero-top"><Logo light /></div>

        <div className="hero-stage">
          <motion.div className="float-card hero-wallet" initial={{ opacity: 0, y: 40, rotate: -8 }} animate={{ opacity: 1, y: 0, rotate: -6 }} transition={{ duration: 0.9, ease, delay: 0.1 }}>
            <motion.div {...float(0)}>
              <div className="hw-inner">
                <div className="hw-row"><span>FastPay balance</span><Zap size={16} /></div>
                <div className="hw-amount">$12,480.50</div>
                <div className="hw-row hw-foot"><span>•••• 4821</span><span>USD</span></div>
              </div>
            </motion.div>
          </motion.div>

          <motion.div className="float-card hero-notif n1" initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, ease, delay: 0.45 }}>
            <motion.div {...float(1.2, 9)} className="notif">
              <span className="notif-icon in"><ArrowDownLeft size={16} /></span>
              <div><strong>Ada sent you $120.00</strong><small>Dinner on Friday</small></div>
            </motion.div>
          </motion.div>

          <motion.div className="float-card hero-notif n2" initial={{ opacity: 0, x: -40 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, ease, delay: 0.7 }}>
            <motion.div {...float(2.4, 10)} className="notif">
              <span className="notif-icon ok"><Check size={16} strokeWidth={3} /></span>
              <div><strong>Payment completed</strong><small>$45.00 to Tunde · just now</small></div>
            </motion.div>
          </motion.div>
        </div>

        <motion.div className="hero-copy" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease, delay: 0.3 }}>
          <h2>Money that moves<br />as fast as you do.</h2>
          <p>Send, receive and track payments instantly, all from one secure wallet.</p>
          <div className="hero-points">
            <span><Zap size={15} /> Instant transfers</span>
            <span><ShieldCheck size={15} /> Secured with PayPal</span>
          </div>
        </motion.div>
      </aside>

      <main className="auth-main">
        <motion.div className="auth-card" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
          <div className="auth-logo"><Logo /></div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
          {children}
        </motion.div>
        <p className="auth-foot">Demo app · No real money is moved.</p>
      </main>
    </div>
  );
}
