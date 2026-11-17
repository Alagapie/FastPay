/** Simple generic "P" mark used to label PayPal as a payment method. */
export function PayPalMark({ size = 18 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 20V4h6a4 4 0 0 1 0 8H7" />
    </svg>
  );
}
