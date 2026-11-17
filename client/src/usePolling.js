import { useEffect, useRef } from 'react';

/** Call fn every `ms` milliseconds while the tab is visible. Pass ms = null to stop. */
export function usePolling(fn, ms) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') saved.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}
