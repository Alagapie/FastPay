import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Lock, Mail } from 'lucide-react';
import { useAuth } from '../auth.jsx';
import { Alert, Spinner } from '../components/ui.jsx';
import { Field, PasswordField } from '../components/Field.jsx';
import AuthShell from './AuthShell.jsx';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(form.email, form.password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Welcome back" subtitle="Log in to your FastPay account.">
      <form onSubmit={submit} className="form">
        <Alert>{error}</Alert>
        <Field icon={Mail} label="Email" type="email" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <PasswordField icon={Lock} label="Password" autoComplete="current-password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <motion.button whileTap={{ scale: 0.98 }} className="btn btn-primary btn-block btn-lg" disabled={busy}>
          {busy ? <><Spinner light /> Logging in…</> : <>Log in <ArrowRight size={18} /></>}
        </motion.button>
      </form>
      <p className="auth-switch">
        New to FastPay? <Link to="/register">Create an account</Link>
      </p>
    </AuthShell>
  );
}
