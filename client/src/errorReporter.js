// Sends browser errors to the server (server/data/client-errors.log) so crashes can be diagnosed.

let sent = 0;

export function reportError(kind, error, extra = {}) {
  if (sent++ > 50) return; // don't flood the server from one broken page
  const payload = {
    kind,
    message: String(error?.message ?? error ?? 'Unknown error'),
    stack: String(error?.stack ?? ''),
    path: window.location.pathname,
    ...extra,
  };
  try {
    const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    if (!navigator.sendBeacon?.('/api/client-errors', body)) {
      fetch('/api/client-errors', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    }
  } catch {
    /* reporting must never throw */
  }
}

/** Report uncaught errors and promise rejections. Errors already handled (defaultPrevented) are skipped. */
export function installGlobalErrorReporting() {
  window.addEventListener('error', (e) => {
    if (e.defaultPrevented) return;
    // "Script error." with no file = an error inside another site's script (PayPal). Browsers hide the details.
    if (e.message === 'Script error.' && !e.filename) return;
    reportError('uncaught', e.error ?? e.message, { source: e.filename });
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (e.defaultPrevented) return;
    reportError('promise', e.reason);
  });
}
