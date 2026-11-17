// Every outcome the investigation can reach. Each one is decided by code from evidence.
//
// Rule: the customer's debit, the PayPal capture, FastPay accepting it, and the wallet credit are
// SEPARATE facts. A missing credit is never read as "failed": it can be a delay, a missed webhook,
// a reconciliation gap or a real failure, and only evidence decides which.
//
//   lost      money left someone and has not reached its destination or come back
//   final     nothing more will happen on its own (a re-check can't change it)
//   exception staff must look at it: an exception is opened with an owner and an escalation time
export const FINDINGS = {
  PAYMENT_COMPLETED: { title: 'Payment completed and the wallet credit is recorded', lost: false, final: true, exception: false },
  PAYMENT_PENDING: { title: 'Payment still processing', lost: false, final: false, exception: false },
  PAYMENT_CAPTURED_WALLET_NOT_CREDITED: { title: 'PayPal completed the payment, but FastPay has not recorded the wallet credit', lost: true, final: false, exception: true },
  DEBITED_NOT_CREDITED: { title: 'Balance debited, but FastPay has not recorded the wallet credit', lost: true, final: false, exception: true },
  PAYOUT_FAILED: { title: 'The payment was taken, but the payout or credit failed', lost: true, final: false, exception: true },
  DUPLICATE_PAYMENT: { title: 'The same payment went through more than once', lost: true, final: true, exception: true },
  PAYMENT_FAILED: { title: 'The payment was not completed, and no money was taken', lost: false, final: true, exception: false },
  PAYMENT_REFUNDED: { title: 'The payment was refunded', lost: false, final: true, exception: false },
  INVESTIGATION_INCONCLUSIVE: { title: 'The final payment status cannot be confirmed yet', lost: false, final: false, exception: true },
};

/** Outcomes a "Check again" can change. */
// Older reports (before v4) used STILL_PROCESSING / INCONCLUSIVE / DEBITED_NOT_CREDITED etc.: they can be re-checked too.
const LEGACY_RERUNNABLE = ['STILL_PROCESSING', 'INCONCLUSIVE', 'PAYPAL_CHARGED_NOT_RECORDED', 'PAYOUT_FAILED_NOT_RETURNED', 'AMOUNT_MISMATCH'];
export const RERUNNABLE = new Set([...Object.entries(FINDINGS).filter(([, f]) => !f.final).map(([k]) => k), ...LEGACY_RERUNNABLE]);

export const CLAIM_RESULTS = {
  SUPPORTED: 'The records support the complaint',
  NOT_SUPPORTED: 'The records do not support the complaint',
  EXPLAINED: 'The complaint is correct, but no money was lost',
  PENDING: 'Too early to tell; the payment is still in progress',
  UNDETERMINED: 'The records alone cannot settle this complaint',
};

const NOT_ARRIVED = ['RECIPIENT_NOT_CREDITED', 'TOP_UP_NOT_REFLECTED', 'CASH_OUT_NOT_RECEIVED', 'EXPECTED_MONEY_NOT_RECEIVED'];

/** Does the evidence back up what the customer said? `flags` are the report's discrepancy codes. */
export function assessClaim(complaintType, findingCode, { claimedCents, recordedCents, flags = [] } = {}) {
  const result = (r, note) => ({ result: r, label: CLAIM_RESULTS[r], note });
  const lost = FINDINGS[findingCode]?.lost;
  if (complaintType === 'WRONG_AMOUNT' && flags.includes('AMOUNT_MISMATCH')) return result('SUPPORTED', 'PayPal and FastPay recorded different amounts.');
  if (findingCode === 'INVESTIGATION_INCONCLUSIVE') return result('UNDETERMINED', 'Some records could not be checked or do not agree.');
  if (findingCode === 'PAYMENT_PENDING') return result('PENDING', 'Check again once the payment has had time to finish.');

  if (NOT_ARRIVED.includes(complaintType)) {
    if (findingCode === 'PAYMENT_COMPLETED') return result('NOT_SUPPORTED', 'The records show the wallet credit was posted.');
    if (findingCode === 'PAYMENT_FAILED') return result('EXPLAINED', 'The money did not arrive because the payment was not completed. Nothing was taken.');
    if (findingCode === 'PAYMENT_REFUNDED') return result('EXPLAINED', 'The money did not arrive because the payment was refunded.');
    if (lost) return result('SUPPORTED', 'The records show money was taken and its credit or payout is not recorded.');
  }
  if (complaintType === 'DUPLICATE_PAYMENT') {
    return findingCode === 'DUPLICATE_PAYMENT'
      ? result('SUPPORTED', 'More than one identical payment went through.')
      : result('NOT_SUPPORTED', 'No other identical payment went through around the same time.');
  }
  if (complaintType === 'REFUND_NOT_RECEIVED') {
    if (findingCode === 'PAYMENT_REFUNDED') return result('NOT_SUPPORTED', 'The records show the money was returned.');
    if (findingCode === 'PAYMENT_FAILED') return result('NOT_SUPPORTED', 'No money was taken, so there was nothing to return.');
    if (lost) return result('SUPPORTED', 'Money was taken and has not been returned.');
    return result('UNDETERMINED', 'The payment completed normally. There is no record of a refund being due.');
  }
  if (complaintType === 'WRONG_AMOUNT') {
    if (claimedCents != null && recordedCents != null && claimedCents !== recordedCents) {
      return result('UNDETERMINED', 'The amount recorded is different from the amount the customer mentioned, but PayPal and FastPay agree with each other.');
    }
    return result('NOT_SUPPORTED', 'All records show the same amount.');
  }
  if (lost) return result('SUPPORTED', 'The records show a problem with this payment.');
  return result('UNDETERMINED', 'The records show what happened to the money, but cannot confirm or rule out this complaint.');
}
