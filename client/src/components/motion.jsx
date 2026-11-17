import { useEffect, useRef, useState } from 'react';
import { animate, motion } from 'framer-motion';
import { money } from '../format.js';

export const ease = [0.16, 1, 0.3, 1];

export const page = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.45, ease } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.2 } },
};

export const list = { hidden: {}, show: { transition: { staggerChildren: 0.045, delayChildren: 0.05 } } };
export const item = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 32 } },
};

/** Fade-and-rise wrapper; `delay` staggers sections on a page. */
export function Rise({ delay = 0, className, children, as = 'div' }) {
  const C = motion[as];
  return (
    <C className={className} initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease, delay }}>
      {children}
    </C>
  );
}

/** Money that counts up/down smoothly whenever the value changes. */
export function AnimatedMoney({ cents = 0, currency = 'USD', hidden }) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const controls = animate(from.current, cents, {
      duration: 1.1,
      ease,
      onUpdate: (v) => setValue(Math.round(v)),
    });
    from.current = cents;
    return () => controls.stop();
  }, [cents]);
  if (hidden) return <span>••••••</span>;
  return <span className="tabular">{money(value, currency)}</span>;
}

/** Self-drawing status icon used on result screens. */
export function StatusGlyph({ status: rawStatus, size = 96 }) {
  const status = rawStatus;
  const stroke = { SUCCESS: '#10b981', FAILED: '#ef4444', PENDING: '#f59e0b' }[status];
  return (
    <motion.div
      className={`glyph glyph-${status.toLowerCase()}`}
      style={{ width: size, height: size }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={status === 'FAILED' ? { scale: 1, opacity: 1, x: [0, -10, 10, -6, 6, 0] } : { scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18, x: { delay: 0.55, duration: 0.45 } }}
    >
      <span className="glyph-ring" />
      <svg viewBox="0 0 52 52" width={size * 0.5} height={size * 0.5} fill="none" stroke={stroke} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
        {status === 'SUCCESS' && (
          <motion.path d="M14 27 l8 8 l16 -18" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }} />
        )}
        {status === 'FAILED' && (
          <>
            <motion.path d="M16 16 L36 36" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.2, duration: 0.3 }} />
            <motion.path d="M36 16 L16 36" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.4, duration: 0.3 }} />
          </>
        )}
        {status === 'PENDING' && (
          <>
            <circle cx="26" cy="26" r="17" strokeOpacity="0.25" />
            <motion.path d="M26 15 V26 L33 31" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.2, duration: 0.5 }} />
          </>
        )}
      </svg>
    </motion.div>
  );
}
