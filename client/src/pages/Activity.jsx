import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../api.js';
import { SkeletonList, Spinner, TxList } from '../components/ui.jsx';
import { Rise } from '../components/motion.jsx';
import { usePolling } from '../usePolling.js';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sent', label: 'Sent' },
  { value: 'received', label: 'Received' },
  { value: 'deposits', label: 'Added' },
  { value: 'withdrawals', label: 'Cashed out' },
  { value: 'requests', label: 'Requests' },
];
const STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'SUCCESS', label: 'Successful' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'FAILED', label: 'Not sent' },
  { value: 'REFUNDED', label: 'Refunded' },
];
const PAGE = 20;

export default function Activity() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') || 'all';
  const status = params.get('status') || '';
  const [items, setItems] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const query = useCallback(
    (offset, limit) => api.get(`/transactions?filter=${filter}&status=${status}&limit=${limit}&offset=${offset}`),
    [filter, status],
  );

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    query(0, PAGE)
      .then((r) => { if (!cancelled) { setItems(r.items); setHasMore(r.has_more); setError(''); } })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [query]);

  const hasPending = items?.some((t) => t.status === 'PENDING');
  usePolling(async () => {
    const r = await query(0, Math.max(items?.length ?? 0, PAGE));
    setItems(r.items);
    setHasMore(r.has_more);
  }, hasPending ? 3000 : null);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await query(items.length, PAGE);
      setItems([...items, ...r.items]);
      setHasMore(r.has_more);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const update = (key, value) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="wide">
      <div className="page-head">
        <h1 className="page-title">Activity</h1>
        <p className="muted">Every payment, deposit and transfer, with its status.</p>
      </div>
      <Rise className="card">
        <div className="toolbar">
          <div className="tabs" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.value} role="tab" aria-selected={filter === f.value} className={filter === f.value ? 'active' : ''} onClick={() => update('filter', f.value)}>
                {filter === f.value && <motion.span layoutId="tab-pill" className="tab-pill" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                <span>{f.label}</span>
              </button>
            ))}
          </div>
          <select value={status} onChange={(e) => update('status', e.target.value)} aria-label="Filter by status">
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {error && <p className="muted">{error}</p>}
        {items === null ? <SkeletonList rows={5} /> : <TxList grouped items={items} empty="No transactions match these filters." />}
        {hasMore && (
          <button className="btn btn-soft btn-block" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><Spinner /> Loading…</> : 'Load more'}
          </button>
        )}
      </Rise>
    </div>
  );
}
