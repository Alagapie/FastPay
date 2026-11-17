# FastPay

A peer-to-peer wallet app, plus the three modules that help when a payment goes wrong: **investigation**,
**resolution**, and **voice**.

> Sandbox / demo project: payments are simulated or run in the PayPal Sandbox. **No real money moves.**

## Modules

FastPay is one wallet ledger with four modules around it.

| Module | Folder | Runs on | What it does |
|---|---|---|---|
| **1. Wallet** | `server/`, `client/` | API `:4000`, web `:5173` | Sign-up and sign-in, USD wallet, PayPal top-ups, peer-to-peer sends, cash out, money requests, transaction history and details |
| **2. Investigation** | `investigation/` | `:4100` | The customer describes the problem; the module finds the payment, asks them to confirm it, checks FastPay's and PayPal's evidence, and writes a report |
| **3. Resolution** | `resolution/` (called by Module 2) | – | Policy, approval and execution. Decides what may be done, who must approve it, and performs the fix through FastPay's resolution window |
| **4. Voice** | `digital-human/` | `:4200` | Speak and understand English, Pidgin, Hausa, Yoruba or Igbo; hear the answer in the same language (YarnGPT) |

Module details live next to the code:

- [Module 2: Investigation](investigation/README.md)
- [Module 3: Resolution](resolution/README.md)
- [Module 4: Voice](digital-human/README.md)

Supporting folders that are **not** part of the running app:

| Folder | What it is |
|---|---|
| `video/` | Renders the project's demo/problem video from `problem.html` with headless Chrome |
| `kd_research/` | Standalone TensorFlow/Keras experiment on knowledge distillation for intrusion detection |

## Repository layout

```text
FastPay/
├─ client/            React + Vite web app
├─ server/            Express API, SQLite ledger, PayPal integration
├─ investigation/     Module 2: payment help, no dependencies
├─ resolution/        Module 3: decision and resolution library, no dependencies
├─ digital-human/     Module 4: voice service, no dependencies
├─ video/             Demo video renderer
├─ kd_research/       ML experiment (standalone)
├─ package.json       Root scripts
└─ README.md
```

## Requirements

- **Node.js 22.13 or newer** — the server uses the built-in `node:sqlite`.
- A PayPal **Sandbox** app for the PayPal flows (optional; the app runs without it).
- Python 3.10 + TensorFlow only for `kd_research/`.

## Quick start (wallet only)

```bash
npm run setup     # installs root, server and client dependencies
npm run dev       # API on :4000, web app on http://localhost:5173
```

`server/.env` holds the settings (copy `server/.env.example` if it is missing). Without PayPal keys the app
still works fully, and you add money with a **test deposit**.

## Run all four modules

Start them in this order, each in its own terminal:

```bash
# 1. Wallet API + web app
npm run dev

# 2. Payment help (Module 2, with Module 3 inside it)
npm start --prefix investigation        # http://localhost:4100

# 3. Voice (Module 4)
npm start --prefix digital-human        # http://localhost:4200
```

Modules 2–4 have **no dependencies**, so there is nothing to install for them.

The modules share FastPay's `fp_session` cookie, which works while everything runs on `localhost`. On
separate domains you would need a shared parent domain or a sign-in hand-off.

## Configuration

Each service reads its own `.env` file. Every file has a committed `.env.example`.

| File | Used by | Important values |
|---|---|---|
| `server/.env` | Wallet API | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_WEBHOOK_ID`, `JWT_SECRET`, `ENABLE_SIMULATION`, `INVESTIGATION_API_TOKEN`, `RESOLUTION_API_TOKEN` |
| `investigation/.env` | Modules 2 + 3 | `META_API_KEY`, `META_BASE_URL`, `META_MODEL`, `FASTPAY_INVESTIGATION_TOKEN`, `FASTPAY_RESOLUTION_TOKEN`, `INTERNAL_API_TOKEN` |
| `digital-human/.env` | Module 4 | `META_API_KEY`, `META_BASE_URL`, `YARNGPT_API_KEY`, `INVESTIGATION_URL` |

The two token pairs **must match**:

- `server/.env` `INVESTIGATION_API_TOKEN` = `investigation/.env` `FASTPAY_INVESTIGATION_TOKEN`
- `server/.env` `RESOLUTION_API_TOKEN` = `investigation/.env` `FASTPAY_RESOLUTION_TOKEN`

`.env` files are gitignored. **Never commit them.**

## Tests

```bash
npm test                                  # all three suites (117 tests)
npm test --prefix investigation           # 87 tests
npm test --prefix resolution              # 13 tests
npm test --prefix digital-human           # 17 tests
```

The investigation and resolution suites run FastPay's real investigation and resolution windows against a
temporary database and a fake PayPal. The core wallet server does not have its own automated test suite yet
(see Known limitations).

## Wallet features

| Milestone | Where it lives |
|---|---|
| 1. Authentication | `server/src/routes/auth.js`, `client/src/pages/Login.jsx`, `Register.jsx` |
| 2. User profiles | `/api/users/*`, `client/src/pages/Profile.jsx` |
| 3. Wallet | `ledger.walletSummary`, dashboard balance card, Profile → Wallet |
| 4. Send money | `ledger.transfer`, `client/src/pages/Send.jsx` (recipient → amount → review → result) |
| 5. Receive money | `client/src/pages/Receive.jsx` (account ID, email, shareable payment link) |
| 6. Transaction history | `GET /api/transactions` with filters, `client/src/pages/Activity.jsx` |
| 7. Transaction details | `GET /api/transactions/:reference`, `client/src/pages/TransactionDetail.jsx` |
| 8. Payment failures | "Test mode" outcome picker + settlement worker in `ledger.js` |

## Connecting PayPal Sandbox

1. Sign in at <https://developer.paypal.com> → **Apps & Credentials** → stay on **Sandbox** → **Create App**.
2. Copy the **Client ID** and **Secret** into `server/.env`:
   ```text
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   PAYPAL_ENV=sandbox
   ```
3. In the app's settings in the dashboard, make sure **Payouts** is ticked (needed for Cash out).
4. Restart `npm run dev`.
5. To pay, use a sandbox **Personal** account from **Testing Tools → Sandbox Accounts**, or a test card.
   Payouts are paid from your sandbox **Business** account's balance.

### What PayPal does in FastPay

| Flow | PayPal API | Where |
|---|---|---|
| **Add money**: PayPal or card → my wallet | Orders v2 (create + capture) | `/add-money` |
| **Send with PayPal**: PayPal or card → another user's wallet | Orders v2 (create + capture) | `/send`, "Pay with: PayPal" |
| **Cash out**: my wallet → a PayPal account | Payouts v1 (create + status polling) | `/cash-out` |
| **Pay Later**: pay in 4 / monthly inside checkout | JS SDK `enable-funding=paylater` + Messages | Add money, Send |
| **Request money**: anyone (no FastPay needed) pays an invoice → my wallet | Invoicing v2 (create, send, cancel, status) | `/receive` |
| **Disputes**: a payer opens a PayPal dispute | Disputes v1, via webhooks | Transaction details |
| **Webhooks**: instant updates for all of the above | Webhook signature verification | `POST /api/paypal/webhook` |

All PayPal status changes go through one place, [`server/src/paypalSync.js`](server/src/paypalSync.js). It is
triggered by the browser, by webhooks, and by background polling (the fallback). Each trigger re-reads the
object from PayPal's API instead of trusting the payload, and every update is safe to run twice.

### Webhooks (optional but recommended)

Without webhooks FastPay checks PayPal every 15–60 seconds. With them, updates are instant and disputes are tracked.

1. PayPal must reach your server over HTTPS. For local testing, run a tunnel, e.g.
   `npx cloudflared tunnel --url http://localhost:4000` (or ngrok), and copy the `https://…` URL.
2. Developer Dashboard → your app → **Webhooks → Add webhook**. URL: `https://<tunnel>/api/paypal/webhook`.
   Select: `PAYMENT.CAPTURE.*`, `PAYMENT.PAYOUTS-ITEM.*`, `INVOICING.INVOICE.*`, `CUSTOMER.DISPUTE.*`.
3. Copy the **Webhook ID** into `server/.env` as `PAYPAL_WEBHOOK_ID=` and restart.

Events whose signature PayPal doesn't confirm are rejected, and each event ID is processed only once.

Not used: Subscriptions, Donations and the low-code buttons, which are merchant features that don't fit
a person-to-person wallet. JS SDK v6 is a possible later upgrade; the app uses the stable v5 SDK.

The browser never sees the secret. The server creates each order, the payer approves it in the PayPal
popup, then the server captures it and checks the captured amount before crediting anyone. Cash out
debits the wallet, sends a payout, and checks its status every 15 seconds. If PayPal can't pay it out
(failed, denied, returned), the money goes back into the wallet.

Test mode with PayPal: **"Fails instantly"** sends PayPal's `PayPal-Mock-Response` header, so the sandbox
itself declines (`INSTRUMENT_DECLINED`). **"Debited, not credited"** lets PayPal really charge the payer,
but FastPay never credits the recipient.

## Payment states

Every attempt is saved with a reference like `FP-261112-7KQ2M9XA`, so failures show up in history too.

| Outcome (test mode) | What happens to the money |
|---|---|
| Succeeds instantly | Sender debited, receiver credited, in one atomic DB transaction |
| Pending, then succeeds | Sender debited now (held). Receiver credited after `PENDING_SECONDS` |
| Pending, then fails | Sender debited now (held), then refunded automatically |
| Fails immediately | Nothing moves. Recorded as FAILED |
| Debited, not credited | Payer debited (FastPay balance or PayPal), receiver **never** credited. It stays stuck as "Not credited" and the receiver never sees it. Nothing reverses it. |
| *(real)* Insufficient funds | Nothing moves. Recorded as FAILED with the reason |

Safeguards: amounts are stored as integer cents, the debit is a conditional
`UPDATE … WHERE balance >= amount` (balance can never go negative, and a DB `CHECK` enforces it),
and sends carry an `Idempotency-Key` so a retried or double-clicked request can't pay twice.

## Production build

```bash
npm run build && NODE_ENV=production npm start   # serves the app + API on :4000
```

Before going live: set a strong `JWT_SECRET`, set `ENABLE_SIMULATION=false`, use HTTPS, add rate
limiting on login, and add PayPal webhooks (`PAYMENT.CAPTURE.COMPLETED` / `DENIED`) to settle
deposits that PayPal itself reports as pending.

## Project status and known limitations

This is a working demo, not a production payment service. Known gaps:

- **PayPal-initiated refunds** are not yet written back to the wallet ledger. Payout refunds and pending
  invoices are handled; refunds of checkout captures and of already-paid invoices are not.
- If PayPal returns a **different captured amount**, the payment is recorded as a clean failure even though
  the payer was charged. It should be treated as a debited, stuck payment.
- **No rate limiting** on login or registration.
- **No automated tests for the core wallet** (`server/`, `client/`); Modules 2–4 are well covered.
- `server/package.json` still contains an unused `"fastpay": "file:.."` self-dependency.
- Staff HTTP endpoints stay off until `INTERNAL_API_TOKEN` is set in `investigation/.env`; the CLI
  (`npm run report`) works without it.
- JWT verification does not pin an algorithm.
- `GET /api/users/lookup` allows account/email probing; consider rate limiting it.
- `video/` and `kd_research/` are unrelated to the wallet runtime.
- No license file has been chosen yet.
