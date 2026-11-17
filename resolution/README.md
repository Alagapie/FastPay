# FastPay Module 3: Decision and Resolution

Takes Module 2's investigation report and answers: **what should happen next, and are we authorized to do it?**
Then it does it, for real, through FastPay's own ledger and PayPal (sandbox while `PAYPAL_ENV=sandbox`).

It runs inside the payment-help page (`investigation/`), right after the result card. It keeps its own
decision records in `resolution/data/resolution.db`. It has no dependencies.

| Component | File | Responsibility |
|---|---|---|
| Case Evaluator | `src/policy.js` `evaluate` | Eligible? The report must be fresh, the payment must still be the customer's and still unsettled, the records must agree, and nothing can have been resolved before |
| Resolution Planner | `src/policy.js` `plan` | The only options the policy allows, with exact amount, currency and target |
| Approval Manager | `src/index.js` + `authorizations` | Server-side, single-use, expiring, bound to case + payment + action + amount (terms hash). Authorized by the policy or by the customer's tap |
| Action Executor | `src/executor.js` | Calls FastPay's resolution window. Key `resolve:<payment ref>`. Success is read back from FastPay's ledger |
| Audit Recorder | `src/store.js` `audit` | Append-only, hash-chained (`GET /internal/resolution-audit/verify`) |
| Agent | `src/agent.js` | Meta `muse-spark-1.3` (tested best for tool calling) works the case through guarded tools |

## Policy: the only thing that authorizes money

| Finding | Type | What happens |
|---|---|---|
| `PAYMENT_CAPTURED_WALLET_NOT_CREDITED` (PayPal transfer, you paid) | Customer's choice | Credit the recipient / refund your PayPal / wait |
| Same, for a top-up, an invoice, or you are the receiver | Our fault: policy | FastPay credits the wallet that is owed |
| `DEBITED_NOT_CREDITED` (you sent it) | Customer's choice | Credit the recipient / return to your balance / wait. **After 24h: policy returns it** |
| `DEBITED_NOT_CREDITED` (you are the receiver) | Our fault: policy | FastPay posts your credit |
| `PAYOUT_FAILED` | Our fault: policy | Money returned to the sender's balance |
| `DUPLICATE_PAYMENT` (balance transfer, one extra) | Our fault: policy | The later one comes back as a correcting transfer (refused if the recipient no longer holds it) |
| `DUPLICATE_PAYMENT` (PayPal) | Staff | Needs a refund and a wallet debit together |
| `PAYMENT_PENDING` | – | Wait / check again |
| `INVESTIGATION_INCONCLUSIVE`, records disagree, low confidence | Staff | Never automatic |
| `COMPLETED` / `FAILED` / `REFUNDED` | – | Nothing to do |

For **our-fault** cases the agent carries out the fix as soon as the policy approves it. For a **customer's choice**, the
customer taps Approve on a card showing the exact terms, and it runs at once. Optional: `RESOLUTION_STAFF_LIMIT` adds
staff approval above an amount (`POST /internal/authorizations/:id/staff-approve {"staff": "name"}`).

## How money actually moves

Module 3 never touches FastPay's database. It calls FastPay's **resolution window**
(`server/src/routes/resolution.js`, `/api/resolution`), locked by `RESOLUTION_API_TOKEN` plus the customer's own
session. FastPay then checks everything again itself before posting:

- the payment is this customer's, and only the payer can get money back
- the amount and currency are exactly the payment's
- the money hasn't already been delivered or returned (re-checked inside the database transaction)
- one action per payment, ever. The same key replays the first result, and PayPal gets `PayPal-Request-Id`
- a daily cap per customer (`RESOLUTION_DAILY_LIMIT`, $1000)

It posts normal ledger legs (credit leg, return, or a correcting transfer) through new functions at the end of
`server/src/ledger.js`, and PayPal refunds through `refundCapture` in `paypal.js`. Balances still reconcile, and a
"Check again" in Module 2 then shows COMPLETED or REFUNDED from the ledger alone.

## Agent tools (it has nothing else)

`get_case`, `recheck_payment`, `suggest_option`, `prepare_confirmation`, `carry_out_authorized_action`, `escalate_to_staff`.
No tool takes an amount or a recipient, or approves anything. `carry_out_authorized_action` runs only what the policy or
the customer's tap already authorized. If the agent claims money moved when it didn't, the reply is blocked. If Meta
is down, built-in rules answer instead.

## Setup

`server/.env`: `RESOLUTION_API_TOKEN` (and optionally `RESOLUTION_DAILY_LIMIT`).
`investigation/.env`: `FASTPAY_RESOLUTION_TOKEN`, the same value. The Meta keys are shared with Module 2. Restart both.

## Test

```bash
npm test   # real investigation + FastPay's real resolution window and ledger (temp DB) + fake PayPal
```
