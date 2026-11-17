import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Lock, Mail, UserRound } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { Field, PasswordField, strength } from '../components/Field.jsx';
import AuthShell from './AuthShell.jsx';

const LEVELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'];

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const score = strength(form.password);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await register(form.name, form.email, form.password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="It takes less than a minute. Your USD wallet is ready instantly.">
      <form onSubmit={submit} className="form">
        <Alert>{error}</Alert>
        <Field icon={UserRound} label="Full name" autoComplete="name" required value={form.name} onChange={set('name')} />
        <Field icon={Mail} label="Email" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
        <div>
          <PasswordField icon={Lock} label="Password" autoComplete="new-password" required minLength={8} value={form.password} onChange={set('password')} />
          {form.password && (
            <div className={`strength s${score}`}>
              <div className="strength-bars">
                {[0, 1, 2, 3].map((i) => <span key={i} className={i < score ? 'on' : ''} />)}
              </div>
              <small>{LEVELS[score]}</small>
            </div>
          )}
        </div>
        <PasswordField icon={Lock} label="Confirm password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
        <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" disabled={busy}>
          {busy ? <><Spinner light /> Creating account…</> : <>Create account <ArrowRight size={18} /></>}
        </motion.button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthShell>
  );
}
