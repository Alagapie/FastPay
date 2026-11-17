import { Component } from 'react';
import { reportError } from '../errorReporter.js';

/**
 * Catches a crash while drawing a page, so React doesn't wipe the whole screen white.
 * Shows a recovery card instead and reports the error to the server.
 * `resetKey` (e.g. the current path) clears the error when the user navigates elsewhere.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportError('render', error, { componentStack: info?.componentStack ?? '' });
    console.error('[FastPay] page crashed:', error);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const full = this.props.fullPage;
    return (
      <div className={full ? 'crash crash-full' : 'crash'}>
        <div className="crash-card">
          <div className="crash-icon">!</div>
          <h2>Something went wrong on this page</h2>
          <p className="muted">Your money is safe. Nothing was sent or changed. The problem has been reported.</p>
          {import.meta.env.DEV && <pre className="crash-detail">{String(this.state.error?.message ?? this.state.error)}</pre>}
          <div className="crash-actions">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload page</button>
            <a className="btn btn-soft" href="/">Go to Home</a>
          </div>
        </div>
      </div>
    );
  }
}
