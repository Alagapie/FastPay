// The investigation report: the output of Module 2 and the input to Module 3 (resolution).
//
// Two views of the same investigation:
//   - the INTERNAL report (this whole object): finding codes, checks, raw evidence, PayPal IDs,
//     reconciliation, limits of what could be seen, and guidance for resolution
//   - `customer_view`: the plain explanation and next steps the customer sees
import { assessClaim } from './investigate/findings.js';
import { complaintLabel } from './understand/types.js';
import { describeRange } from './understand/dates.js';
import { buildCustomerView } from './customer-view.js';
import { formatMoney, newId } from './util.js';

export const REPORT_VERSION = 4; // v4: PAYMENT_* outcome codes, pending reasons, exceptions

// For Module 3. A hint, not a decision: Module 3 makes the resolution.
const RESOLUTION_GUIDANCE = {
  PAYMENT_COMPLETED: 'No refund. The wallet credit is recorded. If the recipient still cannot see it, review manually.',
  PAYMENT_PENDING: 'Too early. Re-investigate later before resolving. Escalate if it stays pending past the expected processing time.',
  PAYMENT_CAPTURED_WALLET_NOT_CREDITED: 'PayPal completed the payment, but no wallet credit is recorded. Check for a delayed webhook or sync first, then resolve (post the credit, or refund the PayPal capture).',
  DEBITED_NOT_CREDITED: 'Money left the payer and no credit or return is recorded. Eligible for resolution (complete the credit, or return the money).',
  PAYOUT_FAILED: 'The money was taken, but the payout or credit failed and nothing was returned. Eligible for resolution (return the money, or retry the payout/credit).',
  DUPLICATE_PAYMENT: 'Duplicate payment(s) went through. Eligible for resolution (return the extra amount).',
  PAYMENT_FAILED: 'No money moved. Nothing to resolve.',
  PAYMENT_REFUNDED: 'The money was already returned. Nothing to resolve.',
  INVESTIGATION_INCONCLUSIVE: 'Evidence is missing, delayed or contradictory. Needs human review. Do not resolve automatically.',
};

export function buildReport({ caseRow, customer, statements, confirmation, tx, result, method, breakpoint, incident, timezone = 'Africa/Lagos', now = new Date() }) {
  const ex = caseRow.extraction ?? {};
  const claim = assessClaim(ex.complaint_type, result.finding.code, {
    claimedCents: ex.amount_cents, recordedCents: tx.amount, flags: result.discrepancies.map((d) => d.code),
  });
  const atIssue = { amount: result.amount_at_issue, currency: tx.currency, display: formatMoney(result.amount_at_issue, tx.currency) };

  const summary = [
    result.intro,
    result.finding.explanation,
    `Finding: ${result.finding.title.toLowerCase()}. ${claim.label}.`,
    result.amount_at_issue ? `Amount at issue: ${atIssue.display}.` : null,
  ].filter(Boolean).join(' ');

  const report = {
    report_id: newId('RPT', now),
    report_version: REPORT_VERSION,
    case_id: caseRow.id,
    generated_at: now.toISOString(),
    customer: { user_id: customer.id, name: customer.name, account_id: customer.account_id },
    complaint: {
      type: ex.complaint_type ?? 'OTHER',
      type_label: complaintLabel(ex.complaint_type),
      statements,
      understood_by: method,
      claimed: {
        amount: ex.amount_cents ?? null,
        currency: ex.currency ?? null,
        counterparty: ex.counterparty ?? null,
        date_range: ex.date_range ?? null,
        date_display: describeRange(ex.date_range),
      },
    },
    confirmation: { reference: confirmation.reference, confirmed_at: confirmation.confirmed_at },
    transaction: {
      reference: tx.reference,
      kind: result.kind,
      kind_label: result.kind_label,
      amount: tx.amount,
      currency: tx.currency,
      amount_display: formatMoney(tx.amount, tx.currency),
      created_at: tx.created_at,
      payer: tx.sender_name ? { name: tx.sender_name, account_id: tx.sender_account_id } : tx.type === 'DEPOSIT' && tx.external_account ? { name: tx.external_account } : null,
      payee: tx.receiver_name ? { name: tx.receiver_name, account_id: tx.receiver_account_id } : tx.external_account ? { name: tx.external_account } : null,
      paypal_reference: tx.provider_ref ?? null,
    },
    kind: result.kind,
    perspective: result.perspective,
    counterparty: result.counterparty,
    destination: result.destination,
    limits: result.limits,
    facts: result.facts,
    finding: result.finding,
    pending: result.pending, // why it is pending, from evidence only (PAYMENT_PENDING)
    claim_assessment: claim,
    amount_at_issue: atIssue,
    related_references: result.related_references,
    confidence: result.confidence,
    resolution_guidance: incident?.status === 'SUSPECTED'
      ? `${RESOLUTION_GUIDANCE[result.finding.code]} Linked to suspected incident ${incident.incident_id}: confirm the root cause with engineering and resolve the linked cases together.`
      : RESOLUTION_GUIDANCE[result.finding.code],
    // Internal only: which step failed, and whose step it was.
    broke_at: breakpoint ?? null,
    incident: incident ?? { status: 'NOT_CHECKED', reasons: [], signals: null },
    money_moved_by_investigation: false,
    money_trail: result.money_trail,
    checks: result.checks,
    discrepancies: result.discrepancies,
    evidence: result.evidence,
    sources_checked: [...new Set(result.evidence.map((e) => e.source))],
    summary,
  };
  report.customer_view = buildCustomerView(report, timezone);
  return report;
}
