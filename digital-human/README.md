# FastPay Module 4: Voice

For customers who can't type, or who are more comfortable in their own language. On the payment-help page
(http://localhost:4100) they tap the **microphone**, speak **English, Pidgin, Hausa, Yoruba or Igbo**, and hear
the answer in their language, in a Nigerian voice from **YarnGPT**. Everything else on the page stays the same.

There is no separate page and no avatar. This folder is the voice service behind the help page, which passes
`/voice/api/*` to it (same origin, same sign-in). The old avatar page is kept in `_old-avatar-page/` only for reference.

```
mic (any language) → hear + understand (Meta) → the ONE matching Module 2/3 call, on the case on screen
                   → Module 2/3's reply → say it in their language (Meta) → YarnGPT voice
```

It has no FastPay, PayPal or database access and **moves no money**. Its only connection is Module 2's customer
API (`/api/cases…`), called with the customer's own FastPay session.

## On the page

- A **language picker** and a **microphone** next to the message box. The microphone stops by itself after a pause.
- With a language other than English picked, **typed** messages are understood in that language too.
- Each spoken exchange shows under its message: what they said, the reply in their language, and **Play**.
- After a **tap** (confirm a payment, choose an option, Approve), the voice says what happened, in their language.
- If the voice service isn't running, the microphone simply doesn't appear, and the page works by typing.

## Run it

```bash
cd digital-human
npm start      # http://localhost:4200 (API only; opening it sends you to the help page)
npm test       # mock Module 2 + mock Meta
npm run languages   # the language test set against the REAL Meta model
npm run voices      # YarnGPT: list voices, save a sample per language in data/samples/
```

Start order: FastPay (`npm run dev`), then payment help (`npm start` in `investigation/`), then this.

## How it works

| Part | File | What it does |
|---|---|---|
| Understanding | `src/language.js` | Language, English meaning and intent (`complaint`, `choose` + number, `none_of_these`, `new_problem`, `greeting`, `question`) |
| Translation | `src/language.js` | In: any language → English for Module 2. Out: English → the customer's language |
| Hearing | `src/meta.js` | The recording (16 kHz WAV) is heard and understood by Meta `muse-spark-1.1` in one call |
| Speaking | `src/voice.js` | YarnGPT, one female voice for all five languages. Without a key: the browser's voice (English / Pidgin) |
| Orchestrator | `src/orchestrator.js` | Code picks the one Module 2/3 call for the case's stage (open, pick a payment, none of these, choose an option, or a message), and narrates what changed after taps |
| Memory | `src/store.js` | Language + current case per customer, and a transcript. No payment data |
| On the page | `investigation/public/voice.js` | Microphone, language picker, playback, the spoken note under each message |

## Meta models (tested, see `npm run languages`)

| Job | Model | Why |
|---|---|---|
| Understand the customer | `muse-spark-1.1` | Most faithful on who-paid-whom in every language, ~2 s |
| Reply in their language | `muse-ember-1.0` | ~3 s, good Hausa/Yoruba/Igbo/Pidgin; its output is checked |

Module 3's own agent stays on `muse-spark-1.3`: the faster models skipped steps in tool calling.

## Safety

- **Money is never approved by voice.** Voice can pick a payment or an option. The confirmation card is read aloud
  and the customer must **tap Approve**, which Module 3 checks against the exact terms.
- **Amounts and references can't be mistranslated.** Every `$…` amount and `FP-…` reference in Module 2/3's English
  must appear unchanged in the translation, or the English is spoken instead.
- **The voice credit can't be misused.** `/api/speak` only voices one of its own recent replies to that customer.
- **Module 2 decides.** The case on screen is used only if Module 2 says it belongs to the signed-in customer.

## Not done yet

- **Native-speaker review** of the Hausa, Yoruba and Igbo wording (`scripts/language-check.js`).
