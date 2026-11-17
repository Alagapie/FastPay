import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, wallet: null, config: null });

  const refresh = useCallback(async () => {
    try {
      const { user, wallet } = await api.get('/auth/me');
      setState((s) => ({ ...s, loading: false, user, wallet }));
    } catch {
      setState((s) => ({ ...s, loading: false, user: null, wallet: null }));
    }
  }, []);

  const refreshWallet = useCallback(async () => {
    const { wallet } = await api.get('/wallet');
    setState((s) => ({ ...s, wallet }));
    return wallet;
  }, []);

  useEffect(() => {
    api.get('/config').then((config) => setState((s) => ({ ...s, config }))).catch(() => {});
    refresh();
  }, [refresh]);

  const login = async (email, password) => {
    const { user, wallet } = await api.post('/auth/login', { email, password });
    setState((s) => ({ ...s, user, wallet }));
  };

  const register = async (name, email, password) => {
    const { user, wallet } = await api.post('/auth/register', { name, email, password });
    setState((s) => ({ ...s, user, wallet }));
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    setState((s) => ({ ...s, user: null, wallet: null }));
  };

  const setUser = (user) => setState((s) => ({ ...s, user: { ...s.user, ...user } }));

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout, refresh, refreshWallet, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
