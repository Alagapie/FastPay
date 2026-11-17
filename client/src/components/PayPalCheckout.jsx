import { useRef } from 'react';
import { PayPalButtons, PayPalMessages, PayPalScriptProvider, usePayPalScriptReducer } from '@paypal/react-paypal-js';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Spinner } from './ui.jsx';

// PayPal's SDK throws a couple of harmless errors when its buttons/messages are removed while still
// rendering (e.g. leaving the page mid-load): "zoid destroyed all components" and a null `nodeType` read.
// Swallow only those, and only when they come from PayPal's own script.
if (typeof window !== 'undefined' && !window.__fastpayPayPalGuard) {
  window.__fastpayPayPalGuard = true;
  const text = (e) => String(e?.message ?? e?.error?.message ?? e?.reason?.message ?? e?.reason ?? '');
  const fromPayPal = (e) => String(e?.filename ?? e?.error?.stack ?? e?.reason?.stack ?? '').includes('paypal.com');
  const harmless = (e) => {
    const t = text(e);
    return t.includes('zoid destroyed all components') || (t.includes("reading 'nodeType'") && fromPayPal(e));
  };
  window.addEventListener('error', (e) => { if (harmless(e)) e.preventDefault(); });
  window.addEventListener('unhandledrejection', (e) => { if (harmless(e)) e.preventDefault(); });
}

/**
 * PayPal Smart Buttons: PayPal balance, Pay Later (pay in 4 / monthly) and debit/credit card.
 * Pay Later shows automatically for eligible buyers and amounts, with a "Pay in 4" message above the buttons.
 * The server creates and captures the order, so the PayPal secret never reaches the browser.
 *
 *   createPath  – server endpoint that creates the order, e.g. /deposits/paypal/orders
 *   payload     – body sent to createPath ({ amount, recipient, note })
 *   simulate    – test outcome passed to the capture call
 */
export default function PayPalCheckout(props) {
  const { config, wallet } = useAuth();
  if (!config?.paypalClientId) return null;
  return (
    <PayPalScriptProvider
      options={{
        clientId: config.paypalClientId,
        currency: wallet?.currency || 'USD',
        intent: 'capture',
        components: 'buttons,messages',
        enableFunding: 'paylater',
      }}
    >
      <Buttons {...props} sandbox={config.paypalEnv === 'sandbox'} />
    </PayPalScriptProvider>
  );
}

function Buttons({ createPath, payload, simulate, disabled, onDone, onError, sandbox }) {
  const [{ isPending, isRejected }] = usePayPalScriptReducer();
  // PayPal keeps the callbacks from its first render, so read the latest values through a ref.
  const latest = useRef({});
  latest.current = { payload, simulate };

  if (isRejected) return <Alert>Could not load PayPal. Check the client ID and your connection.</Alert>;

  return (
    <div className="paypal-wrap">
      {isPending && <div className="center pad"><Spinner size={26} /></div>}
      {Number(payload?.amount) > 0 && (
        <div className="paylater-msg">
          <PayPalMessages amount={Number(payload.amount)} style={{ layout: 'text', logo: { type: 'inline' }, text: { align: 'center', size: 13 } }} />
        </div>
      )}
      <PayPalButtons
        style={{ layout: 'vertical', shape: 'pill', label: 'pay', height: 48 }}
        disabled={disabled}
        forceReRender={[payload?.amount, payload?.recipient]}
        createOrder={async () => {
          onError('');
          try {
            const { orderId } = await api.post(createPath, latest.current.payload);
            return orderId;
          } catch (err) {
            onError(err.message);
            throw err;
          }
        }}
        onApprove={async (data) => {
          try {
            const { transaction } = await api.post(`/paypal/orders/${data.orderID}/capture`, { simulate: latest.current.simulate });
            onDone(transaction);
          } catch (err) {
            onError(err.message);
          }
        }}
        onCancel={async (data) => {
          if (data?.orderID) await api.post(`/paypal/orders/${data.orderID}/cancel`).catch(() => {});
          onError('PayPal checkout was cancelled. You were not charged.');
        }}
        onError={(err) => {
          console.error(err);
          onError(err?.message || 'PayPal ran into a problem. Please try again.');
        }}
      />
      {sandbox && <p className="small muted center">PayPal Sandbox: log in with a sandbox Personal account or use a test card.</p>}
    </div>
  );
}
