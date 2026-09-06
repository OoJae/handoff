# Payaza Day-1 Probe

Runs the twelve day-1 truth tests from the Fusion Hack plan against Payaza's **test** tenant,
and writes a timestamped results file. Nothing here mutates production.

The two that decide the architecture are **A** and **B**. If a simulated inbound collection does
not produce a spendable payout balance, the whole "money lands -> everyone gets paid" demo climax
has to be rebuilt, and you want to know that before filming the application video.

## Setup

    cp .env.example .env
    # fill in PAYAZA_PUBLIC_KEY (test mode) and, for D-L, the rest

## Run

    node probe.mjs              # all tests
    node probe.mjs A B          # just the two that matter
    node probe.mjs --list

Results land in `results/probe-<timestamp>.md`. **Keep the failures.** A negative result reported
honestly on stage ("we tested Split Settlements, here is what the multi-beneficiary remainder
actually does") is worth more than a feature.

## What each test decides

| Test | Decides |
|---|---|
| A | Does a simulated inbound collection credit a **spendable payout balance**? |
| B | Does a 3-way bulk payout reach terminal `NIP_SUCCESS`, or stall non-terminal? |
| C | Is name enquiry real NIBSS resolution or a canned stub? Are OPay/PalmPay/Kuda in it? |
| D | Are those same wallets **payout-capable**? Resolvable is not payable. |
| E | Kobo arithmetic — `payout_amount` must equal `sum(credit_amount)` exactly. Local, no network. |
| F | Does one bad `bank_code` reject the whole batch, or just that leg? |
| G | Reference length bounds + whether a reused reference is rejected (your only idempotency). |
| H | Narration limits: 26 chars, an em dash, a diacritic. Song titles carry all three. |
| I | Is a dynamic VA on bank_code 1067 provisioned, is `has_amount_validation` honoured, real TTL? |
| J | Split Settlements with three SSA_ codes — the undocumented multi-beneficiary remainder rule. |
| K | Rate limits on 20 sequential name enquiries (undocumented). |
| L | Is `transaction_pin` set and is `postNoDebit` clear? Both silently block every payout. |

## Known API traps this script already encodes

- Auth scheme literal is `Payaza`, **not** `Bearer`. Base64 the public key for REST.
- Environment is the `X-TenantID: test` header, not the URL. `/live/` is a fixed path prefix.
- Transfer `transaction_reference` min 10 chars, card max ~15 -> this generates **12**.
- `narration` <= 25 chars, ASCII only, no specials -> ASCII-folded and truncated before sending.
- No webhook idempotency: dedupe on `transaction_reference` yourself.
