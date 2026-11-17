# FastPay Module 2: Investigation

Investigates a FastPay customer's payment complaint and works out what really happened to the money.

**Understand → Find → Confirm → Investigate → Investigation Report**

The module ends with the report. Module 3 (resolution) takes the report from here.

## How it reaches FastPay: one narrow, read-only window

This module has **no database access, no FastPay secrets and no PayPal keys**. Its only way in is FastPay's
read-only investigation window (`server/src/routes/investigation.js`, mounted at `/api/investigation`):

| It can ask | FastPay answers |
|---|---|
| `/me` | who the signed-in customer is, and their wallet id |
| `/transactions`, `/transactions/:ref`, `/transactions/:ref/similar` | **that customer's own** payments only |
| `/reconciliation` | whether **that customer's own** balance adds up |
| `/transactions/:ref/signals` | **counts only**: how many payments on the same channel got stuck around the same time (for incident detection) |
| `/paypal/{orders,captures,payouts,invoices}/:id` | PayPal's record, read by FastPay (which keeps the keys), only for that customer's payments |

Every request needs **both** this module's key (`FASTPAY_INVESTIGATION_TOKEN`, which equals `INVESTIGATION_API_TOKEN`
in `server/.env`) **and** the customer's own FastPay login. FastPay checks the login itself. Without the key the window
returns 404. It is GET-only, and it never returns test-mode fields (`scheduled_outcome`, `settle_at`, `failure_reason`).

This module keeps its own data in `data/investigation.db`: cases, messages, confirmations, reports, and an append-only audit log.

## Run it

Requires Node 22.13+. There are no dependencies, so there is nothing to install.

```bash
cd investigation
cp .env.example .env     # set FASTPAY_INVESTIGATION_TOKEN (and the Meta keys)
npm start                # http://localhost:4100
npm test                 # 85 tests (they run FastPay's real window against a temp database and a fake PayPal)
npm run report           # internal view: list cases; add -- <CASE-ID> for a full report
```

1. Start FastPay as usual (`npm run dev` in the FastPay folder) and sign in at http://localhost:5173.
2. Open http://localhost:4100 in the same browser.

On start it prints whether the FastPay window is connected. If it says NOT connected, check that FastPay is running and that the two tokens match.

## Meta model

Set `META_API_KEY`, `META_BASE_URL` and `META_MODEL` in `.env`. The endpoint must be OpenAI-compatible (`POST {base}/chat/completions`).
The model is only used to **understand** the message. Code checks every field it returns, works out the dates
itself, and makes every decision about the money. Without the keys, or if the model fails, it uses built-in English rules.

## The four stages

| Stage | File | What it does |
|---|---|---|
| 1. Understand | `src/understand/` | Gets the amount, the other person, the date ("yesterday" → a day in `INVESTIGATION_TIMEZONE`) and the **complaint type** (FastPay's own classification) |
| 2. Find | `src/find/match.js` | Scores the customer's **own** transactions by amount, name (fuzzy), date and kind, and shows up to 5. Asks for more detail if nothing matches |
| 3. Confirm | `src/cases.js` | The customer taps one card. Only a payment that was shown can be confirmed. The investigation **refuses to run** until a confirmation is recorded |
| 4. Investigate | `src/investigate/engine.js` | Rule-based checks on the evidence (below). Produces the report (`src/report.js`) |

### Opening it from the FastPay app

FastPay links here from three places: the **help button** (lifebuoy) in the header, **Payment help** in the account
menu and Profile, and **Report a problem with this payment** on every transaction page. FastPay's `/api/config` gives
the address (`INVESTIGATION_APP_URL` in `server/.env`, default `http://localhost:4100`). The investigation page links
back with **Back to FastPay** (`FASTPAY_APP_URL`). The sign-in is shared: both use FastPay's `fp_session` cookie,
which works while both run on `localhost`. On separate domains you'd need a shared parent domain or a sign-in hand-off.

A transaction link opens `/?ref=FP-…`. The case starts with that payment shown, plus one-tap topics ("Musty hasn't
received it", "I was charged twice"…). The stages don't change: the customer still says what went wrong (stage 1), the
opened payment is offered as the match (stage 2, and "None of these" falls back to a normal search), and they confirm
it (stage 3) before anything is investigated. A link only works for the signed-in customer's own payments, and a
receiver can't use one to learn about a transfer that never reached them.

### Only the customer's own account is ever checked

The investigation never opens the other person's account. That would be a privacy problem, and in real life
it's impossible when they bank somewhere else. Delivery is confirmed the way an institution really can:

| Money went to | Confirmed by |
|---|---|
| Another FastPay wallet | FastPay's own record of **this transfer**: did its credit leg post? |
| A PayPal account (cash out) | **PayPal's payout status**. FastPay can't see the PayPal account |
| Paid with PayPal or card | **PayPal's capture record** shows whether the payer was charged |

Each report lists its `limits`, for example "it cannot tell whether Musty has seen the money".

### What the investigation checks

It reports only what FastPay's own records and PayPal's responses prove. It never looks inside the other person's
account, bank or PayPal. It answers six questions:

1. Did FastPay record the customer's payment (the debit)?
2. What final or current status did PayPal return (order and capture, payout, or invoice)?
3. Did FastPay receive and accept the payment (or send the payout instruction)?
4. Has FastPay's wallet ledger recorded the credit to the recipient?
5. Do the references, amount, currency and recipient match between PayPal and FastPay?
6. If records disagree or evidence is missing: open an exception (see below).

The customer's debit, PayPal's capture, FastPay accepting it and the wallet credit are **separate facts** and are
never merged. A missing credit is never read as "failed": it can be a delay, a missed webhook, a sync gap or a real
failure, and only evidence decides which.

FastPay's customer-facing labels and test-mode fields (`scheduled_outcome`, `failure_reason`, `settle_at`) are never
used, and the last three aren't even read. The one status used is FastPay's own ledger marking a payment `FAILED`
*after* the money was taken, with no credit and no return: that is FastPay's record of a failed credit, and gives
`PAYOUT_FAILED`.

| Outcome | When | Customer sees |
|---|---|---|
| `PAYMENT_PENDING` | PayPal's status is pending (or the checkout is approved but not yet captured), or the payment is within its processing window, and no credit is recorded. `pending.reason` / `pending.says` give the reason, from evidence only | "Your payment is still being processed." |
| `PAYMENT_CAPTURED_WALLET_NOT_CREDITED` | PayPal completed the payment (capture `COMPLETED`, or invoice paid), but FastPay's ledger has no credit | "PayPal completed the payment, but FastPay has not yet recorded the recipient's wallet credit." |
| `PAYMENT_COMPLETED` | PayPal completed it (where PayPal is involved) and FastPay's ledger has the credit (or PayPal paid out the cash out) | "The payment is complete, and …'s wallet has been credited." |
| `PAYMENT_FAILED` | Nothing was taken: PayPal `DECLINED`/`FAILED`, checkout never completed, insufficient funds, invoice cancelled | "The payment was not completed, and no money was taken." |
| `PAYMENT_REFUNDED` | PayPal refunded it, or FastPay returned the money to the balance | "The payment was refunded." |
| `PAYOUT_FAILED` | The money was taken, then the payout or credit failed and nothing was returned (PayPal declined a cash out, a cash out never sent, or FastPay marked the credit failed) | "… the payout/credit failed." |
| `DEBITED_NOT_CREDITED` | Balance transfer: the balance was debited, and still no credit or return after the processing window | "FastPay has not recorded the recipient's wallet credit." |
| `DUPLICATE_PAYMENT` | Identical payments went through within an hour | "Duplicate payment found" |
| `INVESTIGATION_INCONCLUSIVE` | A status couldn't be obtained, or the records disagree (amount, recipient, references). Never a guess | "We cannot yet confirm the final payment status. Do not send the money again." |

The timeline shows each step as recorded, never as a verdict: "Recipient wallet credit — Not yet recorded", not
"Did not happen".

Each report also gives a **claim assessment**: SUPPORTED, NOT_SUPPORTED, EXPLAINED (the complaint is true but no money
was lost), PENDING or UNDETERMINED.

### Exceptions

When money was taken and not delivered, the records disagree or evidence is missing, or a payment stays pending past
`INVESTIGATION_PENDING_ESCALATION_MINUTES` (60), the case gets an **exception**: an owner
(`INVESTIGATION_EXCEPTION_OWNER`, default "Payments operations"), when it was opened, its age, and an escalation time
(`INVESTIGATION_ESCALATION_MINUTES`, default 60; a stuck pending escalates at once). One exception per case: checking
again refreshes it, and a later result that settles the payment (completed, refunded, failed) closes it. Every change
is on the audit trail. List them with `GET /internal/exceptions?status=OPEN|CLOSED|ALL` (shows `age_minutes` and
`overdue`). The investigation never moves money, so re-running it can't create a duplicate credit; FastPay's own
idempotency keys protect the payments themselves.

### The chat

The chat talks like a person and stays open after the result. It greets ("hi" gets a greeting, not a search),
acknowledges the problem once ("I'm sorry Musty hasn't received the $25.00 yet"), confirms what it is checking, and
gives the result in a sentence. After the result the customer can ask **why**, ask about **their money** (it says
plainly that it can't move money and no refund has been made), ask for **a person**, say **thanks**, or say
**check again**, which re-runs the investigation and says whether anything changed. Quick-reply buttons offer the same.
These are plain rules (`src/conversation.js`): the wording never decides anything about the money.

## Where it broke, and incident detection (internal only)

Every report has a `broke_at` section: the step that failed, and whose step it was (FastPay, PayPal, the recipient's
side, the payer, or nothing broke), plus `likely_bug` when the evidence points to a FastPay processing fault.
Examples: a credit leg that never posted is a FastPay fault, a declined card is PayPal, an unclaimed payout is the
recipient's side, and an approved checkout that FastPay never captured is a FastPay fault. Customers are never told
"FastPay has a bug".

When something did break, the investigation asks FastPay's window for **counts** on the same channel around the same
time. A pattern across customers (3+ stuck, 2+ other customers, a high stuck share, or failing PayPal webhooks) marks
the case `incident.status = SUSPECTED` and links it to an incident (`INC-…`) with other cases that have the same
broken step. It's a flag for the team to confirm: the system never declares an outage. The customer sees a calm note
("we're seeing a similar problem with some other payments…"), and the guidance for Module 3 says to resolve the
linked cases together. View incidents with `npm run report -- --incidents` or `GET /internal/incidents`.

## Two views

- **Customer view** (`/api/cases/:id/result`, shown on the page): headline, amount, a plain explanation of what
  the evidence shows, what was checked, **next steps**, and "No refund or new payment has been made". It never
  tells the customer they're wrong. It says "credited to Musty's FastPay wallet", not "Musty received it".
- **Internal view** (`npm run report -- <CASE-ID>`, or `GET /internal/cases/:id/report` with `INTERNAL_API_TOKEN`):
  the full report below, plus the audit trail.

Matching never quietly treats a payment from another day as a match. If the customer said "yesterday" and the payment
was today, the card says so and the customer is asked to check the date. If a good match exists on the right day,
payments from other days aren't shown.

## The report (for Module 3)

The internal report (`npm run report -- <CASE-ID> --json`, or `GET /internal/cases/:id/report`) contains:

`report_id`, `case_id`, `customer`, `complaint` (type, the customer's words, the claimed amount/person/date), `confirmation`,
`transaction`, `finding` {code, title, explanation}, `claim_assessment`, `amount_at_issue`, `related_references`,
`confidence` (HIGH/MEDIUM/LOW), `resolution_guidance` (a hint for Module 3, not a decision), `destination`,
`limits` (what the investigation could not see), `facts` (key timestamps and PayPal IDs), `customer_view`, `money_trail`, `checks` (question, answer, detail, evidence ids), `discrepancies`,
`evidence` (source, label, retrieved_at, PayPal debug id, data), `sources_checked`, `summary` (plain English).

## API

| Method | Path | Stage |
|---|---|---|
| GET | `/api/session` | who is signed in |
| POST | `/api/cases` `{message}` | 1 + 2 |
| POST | `/api/cases/from-payment` `{reference}` | open a case from a payment in the FastPay app |
| POST | `/api/cases/:id/messages` `{message}` | add or correct details |
| POST | `/api/cases/:id/none` | "none of these" |
| POST | `/api/cases/:id/confirm` `{reference}` | 3 |
| POST | `/api/cases/:id/investigate` `{again?}` | 4 |
| GET | `/api/cases`, `/api/cases/:id`, `/api/cases/:id/result` | read (customer view) |
| GET | `/internal/cases`, `/internal/cases/:id/report`, `/internal/exceptions`, `/internal/incidents` | internal, needs `INTERNAL_API_TOKEN` |

POSTs must be JSON from the same origin. Customers only ever see their own cases and payments.

## Not in this version

English text only (no voice yet). There is no resolution step: that's Module 3.
