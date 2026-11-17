import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowRight, Banknote, Bell, Plus, Send, TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { AnimatedMoney, item, list, Rise } from '../components/motion.jsx';
import { SkeletonList, TxList } from '../components/ui.jsx';
import WalletCard from '../components/WalletCard.jsx';
import { useRequestCount } from '../requestCount.jsx';
import { usePolling } from '../usePolling.js';

const ACTIONS = [
  { to: '/send', label: 'Send', sub: 'Pay anyone', icon: Send, tone: 'violet' },
  { to: '/receive', label: 'Receive', sub: 'Get paid', icon: ArrowDownLeft, tone: 'emerald' },
  { to: '/add-money', label: 'Add money', sub: 'From PayPal', icon: Plus, tone: 'blue' },
  { to: '/cash-out', label: 'Cash out', sub: 'To PayPal', icon: Banknote, tone: 'amber' },
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function Dashboard() {
  const { user, wallet, refreshWallet } = useAuth();
  const [recent, setRecent] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const { count: requestCount } = useRequestCount();

  const load = useCallback(async () => {
    try {
      const [{ items }, { stats }] = await Promise.all([
        api.get('/transactions?limit=6'),
        api.get('/wallet/stats'),
        refreshWallet(),
      ]);
      setRecent(items);
      setStats(stats);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [refreshWallet]);

  useEffect(() => { load(); }, [load]);
  const hasPending = recent?.some((t) => t.status === 'PENDING');
  usePolling(load, hasPending ? 3000 : 10000);

  return (
    <div className="dashboard">
      <Rise className="dash-head">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>{greeting()}, {user.name.split(' ')[0]} <motion.span className="wave" animate={{ rotate: [0, 18, -8, 18, 0] }} transition={{ duration: 1.4, delay: 0.6 }}>👋</motion.span></h1>
        </div>
        <Link to="/send" className="btn btn-primary hide-mobile"><Send size={17} /> Send money</Link>
      </Rise>

      {requestCount > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <Link to="/requests" className="req-banner">
            <span className="req-banner-icon"><Bell size={18} /></span>
            <span><strong>{requestCount === 1 ? 'Someone is' : `${requestCount} people are`} waiting for you to pay</strong><small>Tap to view and pay or decline</small></span>
            <ArrowRight size={18} />
          </Link>
        </motion.div>
      )}

      <div className="dash-grid">
        <div className="dash-left">
          <WalletCard user={user} wallet={wallet} />

          <motion.div className="actions" variants={list} initial="hidden" animate="show">
            {ACTIONS.map(({ to, label, sub, icon: Icon, tone }) => (
              <motion.div key={to} variants={item} whileHover={{ y: -4 }} whileTap={{ scale: 0.97 }}>
                <Link to={to} className={`action tone-${tone}`}>
                  <span className="action-icon"><Icon size={20} /></span>
                  <strong>{label}</strong>
                  <small>{sub}</small>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        </div>

        <div className="dash-right">
          <div className="stats">
            <Rise delay={0.1} className="stat stat-in">
              <span className="stat-icon"><TrendingUp size={18} /></span>
              <span className="stat-label">Money in · 30 days</span>
              <span className="stat-value">{stats ? <AnimatedMoney cents={stats.money_in} /> : '—'}</span>
            </Rise>
            <Rise delay={0.18} className="stat stat-out">
              <span className="stat-icon"><TrendingDown size={18} /></span>
              <span className="stat-label">Money out · 30 days</span>
              <span className="stat-value">{stats ? <AnimatedMoney cents={stats.money_out} /> : '—'}</span>
            </Rise>
          </div>

          <Rise delay={0.25} className="card">
            <div className="card-head">
              <h2>Recent activity</h2>
              <Link to="/activity" className="link-arrow">See all <ArrowRight size={15} /></Link>
            </div>
            {error && <p className="muted">{error}</p>}
            {recent === null ? (
              <SkeletonList rows={4} />
            ) : (
              <TxList
                items={recent}
                empty={
                  <>
                    <p><strong>Your wallet is ready.</strong><br />Add money to make your first payment.</p>
                    <Link to="/add-money" className="btn btn-primary"><Plus size={17} /> Add money</Link>
                  </>
                }
              />
            )}
          </Rise>
        </div>
      </div>
    </div>
  );
}
