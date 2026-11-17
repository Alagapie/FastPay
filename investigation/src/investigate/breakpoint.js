// Where it broke: which step failed, and whose step it was. Decided by code from the finding and
// the evidence, never guessed. INTERNAL ONLY: customers are never told "FastPay has a bug".
//
// party:  FASTPAY | PAYPAL | RECIPIENT | PAYER | COUNTERPARTY | NONE | UNKNOWN
// likely_bug: true when the evidence points to a FastPay processing fault that engineering should look at.

export const PARTIES = {
  FASTPAY: 'FastPay',
  PAYPAL: 'PayPal',
  RECIPIENT: "The recipient's side",
  PAYER: 'The payer',
  COUNTERPARTY: 'The other person',
  NONE: 'Nothing broke',
  UNKNOWN: 'Not known yet',
};

const at = (party, stage, summary, explanation, { likely_bug = false, contributing = [] } = {}) => ({
  party, party_label: PARTIES[party], stage, summary, explanation, likely_bug, contributing,
});

export function whereItBroke({ code, kind, facts = {} }) {
  const paypalCheckout = kind === 'PAYPAL_TRANSFER' || kind === 'PAYPAL_TOP_UP';

  switch (code) {
    case 'PAYMENT_COMPLETED':
      return at('NONE', 'NONE', 'Every step completed',
        'The money left the payer and the wallet credit (or payout) is recorded. If it still looks missing, it is most likely not visible yet (the app needs a refresh) or it went to a different person than intended.');

    case 'DEBITED_NOT_CREDITED':
      return at('FASTPAY', 'CREDIT_TO_RECIPIENT', 'FastPay: the credit to the recipient was never recorded',
        'FastPay took the money from the payer, but its own wallet credit was never recorded. Both sides of the transfer are inside FastPay, so this points to a FastPay processing fault.',
        { likely_bug: true });

    case 'PAYMENT_CAPTURED_WALLET_NOT_CREDITED':
      if (kind === 'PAYPAL_REQUEST') {
        return at('FASTPAY', 'CREDIT_AFTER_INVOICE_PAID', 'FastPay: no wallet credit recorded after the invoice was paid',
          'PayPal shows the invoice as paid, but FastPay has not recorded the wallet credit. Typical causes: a missed webhook or a sync gap.', { likely_bug: true });
      }
      if (facts.fastpay_recorded_charge === false) {
        return at('FASTPAY', 'RECORDING_PAYPAL_CHARGE', 'FastPay: a completed PayPal charge was never recorded',
          'PayPal completed the charge, but FastPay has no record of it. Typical causes: a lost capture response or a missed webhook, which the background sync should have caught.',
          { likely_bug: true });
      }
      return at('FASTPAY', 'CREDIT_AFTER_PAYPAL_CHARGE', 'FastPay: no wallet credit recorded after a completed PayPal charge',
        'PayPal completed the charge and FastPay accepted it, but FastPay has not recorded the wallet credit.', { likely_bug: true });

    case 'PAYOUT_FAILED':
      if (kind === 'PAYPAL_CASH_OUT' && facts.payout_failure === 'NEVER_SENT') {
        return at('FASTPAY', 'SENDING_PAYOUT', 'FastPay: the payout was never sent to PayPal',
          'FastPay debited the balance but never sent the payout to PayPal, and did not return the money.', { likely_bug: true });
      }
      if (kind === 'PAYPAL_CASH_OUT') {
        return at('FASTPAY', 'RETURN_TO_PAYER', 'FastPay: the money was not returned after PayPal declined the payout',
          `PayPal did not pay out (status ${facts.paypal_status ?? 'not completed'}), which can happen. FastPay should then return the money to the wallet, and it has not.`,
          { likely_bug: true, contributing: ['PAYPAL'] });
      }
      return at('FASTPAY', 'CREDIT_REJECTED', 'FastPay: the wallet credit failed after the money was taken',
        "FastPay's ledger marked the credit as failed after the money was taken, and did not return it.", { likely_bug: true });

    case 'DUPLICATE_PAYMENT':
      return at('FASTPAY', 'DUPLICATE_PROCESSING', 'The same payment went through more than once',
        "FastPay's repeat-payment protection should stop identical payments. Either the payment was submitted twice and the protection missed it, or one request was processed twice.",
        { likely_bug: true, contributing: ['PAYER'] });

    case 'PAYMENT_FAILED':
      if (paypalCheckout) {
        if (['DECLINED', 'FAILED'].includes(facts.paypal_status)) {
          return at('PAYPAL', 'PAYPAL_DECLINED', 'PayPal declined the payment', 'PayPal declined the payment method, so nothing was charged.');
        }
        if (facts.order_status === 'APPROVED') {
          return at('FASTPAY', 'CAPTURE_NOT_COMPLETED', 'FastPay: an approved PayPal checkout was never completed',
            "The payer approved the PayPal checkout, but FastPay never captured it, so no money was taken. FastPay's background sync should have finished it.",
            { likely_bug: true });
        }
        if (facts.order_status === 'VOIDED') return at('PAYPAL', 'ORDER_VOIDED', 'PayPal voided the checkout', 'The PayPal order was voided, so nothing was charged.');
        if (facts.order_status) {
          return at('PAYER', 'CHECKOUT_NOT_COMPLETED', 'The payer did not finish the PayPal checkout',
            `The PayPal checkout stopped at "${facts.order_status}", before the payer approved it. Nothing was charged.`);
        }
        return at('UNKNOWN', 'NO_PAYPAL_RECORD', 'PayPal has no record of this checkout', 'PayPal has no order for this payment, so nothing was charged.');
      }
      if (kind === 'PAYPAL_REQUEST') {
        return at('COUNTERPARTY', 'INVOICE_NOT_PAID', 'The request was not paid', 'Nothing has moved: the PayPal invoice was cancelled or does not exist.');
      }
      return at('NONE', 'STOPPED_BEFORE_DEBIT', 'Stopped before any money moved',
        "Nothing moved. These records don't say why it was stopped (for example insufficient funds, or a declined payment).");

    case 'PAYMENT_REFUNDED':
      if (kind === 'PAYPAL_CASH_OUT') {
        return at('PAYPAL', 'PAYPAL_PAYOUT', 'PayPal did not pay out, and FastPay returned the money',
          `PayPal could not pay out (status ${facts.paypal_status ?? 'not completed'}). FastPay correctly returned the money.`);
      }
      if (paypalCheckout) return at('NONE', 'REFUNDED', 'PayPal refunded the charge', 'The charge was refunded through PayPal. Nothing is outstanding.');
      return at('FASTPAY', 'CREDIT_TO_RECIPIENT', 'The transfer failed during processing, and FastPay returned the money',
        'FastPay could not complete the transfer, and its safeguard correctly returned the money to the payer.');

    case 'PAYMENT_PENDING':
      if (facts.pending_reason === 'PAYOUT_UNCLAIMED') {
        return at('RECIPIENT', 'CLAIM_BY_RECIPIENT', 'Waiting for the recipient to claim the payout',
          'PayPal sent the payout, but the email has no PayPal account yet.');
      }
      if (facts.pending_reason === 'AWAITING_PAYER') {
        return at('COUNTERPARTY', 'INVOICE_NOT_PAID', 'Waiting for the payer to pay the request', 'The PayPal invoice has not been paid yet.');
      }
      if (facts.pending_reason === 'AWAITING_CAPTURE') {
        return at('FASTPAY', 'AWAITING_CAPTURE', 'Waiting for FastPay to capture an approved PayPal checkout',
          'The payer approved the checkout. FastPay captures approved checkouts in the background; nothing has failed yet.');
      }
      if (['PAYPAL_CAPTURE_PENDING', 'PAYPAL_PAYOUT_PROCESSING', 'PAYPAL_INVOICE_PROCESSING'].includes(facts.pending_reason)) {
        return at('PAYPAL', 'PAYPAL_HOLD', 'PayPal has not completed the payment yet',
          `PayPal has not returned a final status${facts.paypal_hold_reason ? ` (reason ${facts.paypal_hold_reason})` : ''}.`);
      }
      return at('NONE', 'IN_PROGRESS', 'Nothing has failed yet', 'The payment is still within its normal processing time.');

    default: // INVESTIGATION_INCONCLUSIVE
      if (facts.paypal_unreachable) return at('UNKNOWN', 'PAYPAL_UNREACHABLE', 'PayPal could not be checked', "PayPal's records could not be read, so the failing step can't be identified yet.");
      return at('UNKNOWN', 'RECORDS_CONTRADICT', 'The records contradict each other', 'The records disagree with each other, and that needs a manual review.', { likely_bug: true });
  }
}
