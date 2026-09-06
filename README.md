# Handoff

**A Lagos beat handoff becomes a payment.** A producer, writer and vocalist set their shares in naira and
sign by *receiving* ₦100 — the bank returns the real name on the account, which proves control rather than
mere knowledge of an account number. The artist pays into one account. When the money lands, the stems
unlock and one call to Payaza pays everybody at once.

Built for **The Fusion Hack** (The New Church × Payaza, Lagos).

---

## Why this and not another split sheet

Free split sheets already exist — MCSN, one of Nigeria's collecting societies, publishes one. Almost nobody
signs them, and the reason is not ignorance: **the producer wants the document and the artist holds the
money**, so the person with less power is asking the person with more for a favour. That is easy to ignore.

Handoff adds no paperwork. It changes who is holding what. **The producer holds the stems.** The files do
not unlock until the money lands, and the money cannot land except against a signed split. Nobody has to be
persuaded to be fair — the split is simply how the file gets delivered.

## What's here

| Path | What it is |
|---|---|
| `payaza-probe/` | A runnable probe for the twelve day-1 Payaza sandbox tests. Answers whether a simulated inbound collection credits a **spendable payout balance** — the fact the whole release step depends on. |
| `handoff-video-script.txt` | The 90-second application video script, in 8 filmable blocks with delivery cues, plus the submission form answers. |

## The probe

```bash
cd payaza-probe
cp .env.example .env      # add Payaza test keys — they work while KYB is pending
node probe.mjs --list     # what each test decides
node probe.mjs A B        # the two that decide the architecture
node probe.mjs E H        # offline, no keys needed
```

Results land in `payaza-probe/results/`. **Keep the failures.** A negative result reported honestly —
"we tested Split Settlements, here is what the multi-beneficiary remainder actually does" — is worth more
than a feature in front of a judge who wrote the API.

## Payaza API traps encoded here

Verified by parsing `docs.payaza.africa/openapi.json` directly:

- Auth scheme literal is **`Payaza`**, not `Bearer` — the docs call this the #1 cause of 401s.
- Environment switches on the **`X-TenantID: test|live`** header, not the URL. `/live/` is a fixed path prefix.
- **`split_value` is what you retain**, not what the beneficiary receives — inverted vs Paystack. And
  multi-beneficiary remainder division is **undocumented**, so the safe path is collect → ledger → one bulk
  payout, not split settlements.
- Transfer `transaction_reference` min 10 chars, card max ~15 → this generates **12**.
- `narration` ≤ 25 chars, ASCII only → diacritics are folded server-side (`Ìpín` → `Ipin`).
- Webhooks carry **no idempotency** and no documented retry policy → always poll as well as listen.
- `fund_test_virtual_account` simulates an inbound bank transfer in sandbox — the single best
  demo-de-risking endpoint in the stack.

## Status

Pre-build. The seven-day build starts only if shortlisted. Nothing here calls the live Payaza API.
