import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { usePolling } from './usePolling.js';

const RequestCountContext = createContext({ count: 0, refresh: () => {} });

/** Number of open requests waiting for the signed-in user to pay. Polled so new ones appear without a reload. */
export function RequestCountProvider({ children }) {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const { incoming } = await api.get('/requests/count');
      setCount(incoming);
    } catch {
      /* ignore: e.g. signed out */
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  usePolling(refresh, 10000);
  return <RequestCountContext.Provider value={{ count, refresh }}>{children}</RequestCountContext.Provider>;
}

export const useRequestCount = () => useContext(RequestCountContext);
