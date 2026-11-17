import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CalendarDays, Coins, Hash, LifeBuoy, LogOut, Mail, Pencil, PlugZap, ShieldCheck, UserRound, Wallet } from 'lucide-react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { dateTime, money } from '../format.js';
import { Alert, Avatar, CopyButton } from '../components/ui.jsx';
import { Field } from '../components/Field.jsx';
import { Rise } from '../components/motion.jsx';

export default function Profile() {
  const { user, wallet, config, setUser, logout } = useAuth();
  const paypalOn = Boolean(config?.paypalClientId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [msg, setMsg] = useState({ kind: '', text: '' });

  const save = async (e) => {
    e.preventDefault();
    try {
      const { user: updated } = await api.patch('/users/me', { name });
      setUser({ name: updated.name });
      setEditing(false);
      setMsg({ kind: 'success', text: 'Your name was updated.' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    }
  };

  return (
    <div className="narrow">
      <Rise className="card profile-card">
        <div className="profile-banner" />
        <div className="profile-head">
          <motion.div initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 16 }}>
            <Avatar name={user.name} size={84} ring />
          </motion.div>
          <h1>{user.name}</h1>
          <p className="muted"><ShieldCheck size={14} /> Verified FastPay member since {new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</p>
        </div>
        <Alert kind={msg.kind}>{msg.text}</Alert>
        {editing ? (
          <form onSubmit={save} className="form">
            <Field icon={UserRound} label="Full name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
            <div className="row-2">
              <button className="btn btn-primary">Save</button>
              <button type="button" className="btn btn-soft" onClick={() => { setEditing(false); setName(user.name); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <dl className="receipt icons">
            <div><dt><UserRound size={16} /> Name</dt><dd>{user.name} <button className="btn-link" onClick={() => { setEditing(true); setMsg({}); }}><Pencil size={13} /> Edit</button></dd></div>
            <div><dt><Mail size={16} /> Email</dt><dd>{user.email}</dd></div>
            <div><dt><Hash size={16} /> Account ID</dt><dd><code>{user.account_id}</code> <CopyButton value={user.account_id} /></dd></div>
          </dl>
        )}
      </Rise>

      <Rise delay={0.12} className="card">
        <div className="card-head"><h2><Wallet size={18} /> Wallet</h2></div>
        <div className="wallet-tiles">
          <div className="wtile primary"><small>Available</small><strong>{money(wallet?.balance, wallet?.currency)}</strong></div>
          <div className="wtile"><small>Incoming</small><strong>{money(wallet?.pending_incoming, wallet?.currency)}</strong></div>
        </div>
        <dl className="receipt icons">
          <div><dt><Coins size={16} /> Currency</dt><dd>{wallet?.currency} · US Dollar</dd></div>
          <div><dt><Hash size={16} /> Wallet number</dt><dd><code>W-{String(wallet?.id ?? '').padStart(8, '0')}</code></dd></div>
          <div><dt><CalendarDays size={16} /> Opened</dt><dd>{dateTime(wallet?.created_at)}</dd></div>
          <div><dt><ShieldCheck size={16} /> Limit</dt><dd>{money(1_000_000)} per payment</dd></div>
        </dl>
      </Rise>

      <Rise delay={0.18} className="card">
        <div className="card-head"><h2><PlugZap size={18} /> PayPal connection</h2></div>
        <div className="paypal-status">
          {[
            ['Checkout (add money, pay with PayPal)', paypalOn],
            ['Pay Later', paypalOn],
            ['Payouts (cash out)', paypalOn],
            ['Invoicing (request money)', paypalOn],
            ['Webhooks (instant updates and disputes)', Boolean(config?.paypalWebhooks)],
          ].map(([label, on]) => (
            <div key={label} className="ps-row">
              <span className={`ps-dot ${on ? 'on' : ''}`} />
              <span>{label}</span>
              <span>{on ? (config?.paypalEnv === 'live' ? 'Live' : 'Sandbox') : 'Off'}</span>
            </div>
          ))}
        </div>
        {!paypalOn && <p className="small muted" style={{ marginTop: 12 }}>Add PayPal keys to <code>server/.env</code> and restart the server to switch these on.</p>}
        {paypalOn && !config?.paypalWebhooks && (
          <p className="small muted" style={{ marginTop: 12 }}>Without webhooks, FastPay checks PayPal every 15–60 seconds instead of instantly.</p>
        )}
      </Rise>

      {config?.investigationUrl && (
        <Rise delay={0.24} className="card help-card">
          <div className="card-head"><h2><LifeBuoy size={18} /> Payment help</h2></div>
          <p className="muted">
            Money sent but not received, a top-up that isn't showing, charged twice? Tell us in your own words. We'll find
            the payment, check FastPay's and PayPal's records, and show you exactly what happened.
          </p>
          <a href={config.investigationUrl} className="btn btn-soft btn-block"><LifeBuoy size={17} /> Get help with a payment</a>
        </Rise>
      )}

      <motion.button whileTap={{ scale: 0.98 }} className="btn btn-danger btn-block btn-lg" onClick={async () => { await logout(); navigate('/login', { replace: true }); }}>
        <LogOut size={18} /> Log out
      </motion.button>
    </div>
  );
}
