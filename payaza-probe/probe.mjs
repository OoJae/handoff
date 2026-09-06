#!/usr/bin/env node
/**
 * Payaza Day-1 Probe — Fusion Hack / Handoff
 *
 * Runs the twelve day-1 truth tests against Payaza's TEST tenant and writes a
 * results file. Tests A and B decide the architecture; run those first.
 *
 * Encoded API traps (all verified against docs.payaza.africa):
 *   - Auth scheme literal is "Payaza", NOT "Bearer". Public key is base64'd for REST.
 *   - Environment is the X-TenantID header, not the URL. "/live/" is a fixed path prefix.
 *   - transfer transaction_reference >= 10 chars, card <= ~15  -> we generate 12.
 *   - narration <= 25 chars, ASCII only, no specials -> folded + truncated before send.
 *   - split_value is what YOU RETAIN, not what the beneficiary gets (inverted vs Paystack).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.payaza.africa/live';
const TIMEOUT_MS = 30_000;

/* ---------------------------------------------------------------- env ---- */

function loadEnv() {
  const p = join(HERE, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && !process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnv();

const PUBLIC_KEY = process.env.PAYAZA_PUBLIC_KEY || '';
const PIN = process.env.PAYAZA_TRANSACTION_PIN || '';

/* ------------------------------------------------------------ helpers ---- */

const log = [];
function say(s = '') { console.log(s); log.push(s); }

/** 12 chars: satisfies transfer min 10 AND card max ~15. Trap G. */
let refCounter = 0;
function makeRef(prefix = 'HF') {
  const t = Date.now().toString(36).toUpperCase();
  const n = (refCounter++).toString(36).toUpperCase().padStart(2, '0');
  return (prefix + t + n).slice(0, 12).padEnd(12, '0');
}

/** narration: <=25 chars, ASCII only, no specials. Trap H. */
function safeNarration(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip diacritics: Ìpín -> Ipin
    .replace(/[^A-Za-z0-9 ]/g, ' ')                    // drop em dashes, apostrophes
    .replace(/\s+/g, ' ').trim()
    .slice(0, 25);
}

/** Integer-kobo split with deterministic remainder to the largest share. Trap E. */
function splitKobo(nairaAmount, shares) {
  const totalKobo = Math.round(nairaAmount * 100);
  const totalPct = shares.reduce((a, s) => a + s.pct, 0);
  if (totalPct !== 100) throw new Error(`shares total ${totalPct}, must be exactly 100`);
  const legs = shares.map(s => ({ ...s, kobo: Math.floor((totalKobo * s.pct) / 100) }));
  const remainder = totalKobo - legs.reduce((a, l) => a + l.kobo, 0);
  if (remainder > 0) {
    let big = 0;
    for (let i = 1; i < legs.length; i++) if (legs[i].pct > legs[big].pct) big = i;
    legs[big].kobo += remainder;
  }
  return { totalKobo, legs, remainder };
}

async function call(method, path, body, { raw = false } = {}) {
  if (!PUBLIC_KEY) return { ok: false, skipped: true, error: 'PAYAZA_PUBLIC_KEY not set' };
  const url = BASE + path;
  const headers = {
    // TRAP: scheme literal is "Payaza", not "Bearer". Docs call this the #1 cause of 401s.
    Authorization: `Payaza ${Buffer.from(PUBLIC_KEY).toString('base64')}`,
    'X-TenantID': 'test',          // TRAP: env is a header, not the URL
    'X-ProductID': 'app',
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method, headers, signal: ctl.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, json, text: raw ? text : text.slice(0, 1500) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e), ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

function show(label, r) {
  if (r.skipped) { say(`   ~ ${label}: SKIPPED (${r.error})`); return; }
  const head = r.ok ? 'OK ' : 'ERR';
  say(`   ${head} ${label}  [${r.status ?? '---'}] ${r.ms ?? '?'}ms`);
  if (r.error) say(`       error: ${r.error}`);
  const payload = r.json ? JSON.stringify(r.json, null, 2) : r.text;
  if (payload) say('       ' + String(payload).split('\n').join('\n       ').slice(0, 1400));
}

function parseAccount(spec) {
  if (!spec) return null;
  const [bank_code, account_number, expect] = spec.split(':');
  if (!bank_code || !account_number) return null;
  return { bank_code, account_number, expect: expect || '(unstated)' };
}
const PROBE_ACCOUNTS = [1, 2, 3]
  .map(i => parseAccount(process.env[`PROBE_ACCOUNT_${i}`]))
  .filter(Boolean);

/* -------------------------------------------------------------- tests ---- */

const tests = {};
let mainAccountRef = null;
let vaNumber = null;

tests.A = {
  title: 'Does a simulated inbound collection produce a SPENDABLE payout balance?',
  why: 'Nothing documents that collections credit the payout ledger. If not, the demo climax is fiction.',
  async run() {
    say('   1) read main account balance BEFORE');
    const before = await call('GET', '/payaza-account/api/v1/mainaccounts/merchant/enquiry/main');
    show('enquiry/main (before)', before);
    mainAccountRef = before.json?.data?.payazaAccountReference ?? before.json?.payazaAccountReference ?? null;
    const readBal = (r) => r.json?.data?.accountBalance ?? r.json?.accountBalance ?? null;

    say('   2) create a dynamic virtual account (bank_code 1067, amount validation on)');
    const vaRef = makeRef('VA');
    const va = await call('POST', '/merchant-collection/merchant/virtual_account/generate_virtual_account', {
      account_reference: vaRef,
      customer_first_name: 'Probe', customer_last_name: 'Tester',
      customer_email: 'probe@example.com', customer_phone_number: '08000000000',
      bank_code: '1067',
      transaction_amount: 60001,
      has_amount_validation: true,
      currency: 'NGN',
    });
    show('generate_virtual_account', va);
    vaNumber = va.json?.data?.virtual_account_number ?? va.json?.data?.virtualAccountNumber
            ?? va.json?.virtual_account_number ?? null;
    say(`   -> virtual account number: ${vaNumber ?? 'NOT RETURNED'}`);

    say('   3) simulate an inbound bank transfer into it');
    const fund = await call('POST', '/merchant-collection/payaza/virtual_account/fund_test_virtual_account', {
      virtual_account_number: vaNumber, amount: 60001, currency: 'NGN',
    });
    show('fund_test_virtual_account', fund);

    say('   4) read main account balance AFTER');
    await new Promise(r => setTimeout(r, 4000));
    const after = await call('GET', '/payaza-account/api/v1/mainaccounts/merchant/enquiry/main');
    show('enquiry/main (after)', after);

    const b = readBal(before), a = readBal(after);
    say('');
    if (before.skipped) { say('   >>> NOT RUN — no credentials. This is the one test you cannot skip.'); return; }
    say(`   >>> VERDICT: balance before=${b} after=${a}`);
    if (b !== null && a !== null && Number(a) > Number(b)) {
      say('   >>> A PASSES. Collections credit a spendable payout balance. Demo climax is real.');
    } else {
      say('   >>> A INCONCLUSIVE/FAILS. Collections may NOT credit the payout ledger.');
      say('   >>> If so: the release leg must be funded separately. Redesign before filming.');
    }
  },
};

tests.B = {
  title: 'Does a 3-beneficiary bulk payout reach a TERMINAL state?',
  why: 'Design the UI around the answer, not around hope. Stalling at TRANSACTION_INITIATED / 09 is common.',
  async run() {
    if (PROBE_ACCOUNTS.length < 1) { say('   ~ needs at least PROBE_ACCOUNT_1. Skipping.'); return; }
    const shares = [{ pct: 45 }, { pct: 30 }, { pct: 25 }];
    const { totalKobo, legs } = splitKobo(600.01, shares);   // small, safe amount
    const accts = [0, 1, 2].map(i => PROBE_ACCOUNTS[i] || PROBE_ACCOUNTS[0]);
    const batch_reference = makeRef('BR');
    const beneficiaries = legs.map((l, i) => ({
      credit_amount: l.kobo / 100,
      account_number: accts[i].account_number,
      bank_code: accts[i].bank_code,
      account_name: accts[i].expect,
      narration: safeNarration(`Handoff probe leg ${i + 1}`),
      transaction_reference: makeRef('LG'),
    }));
    const payout_amount = beneficiaries.reduce((a, b) => a + b.credit_amount, 0);
    say(`   payout_amount=${payout_amount}  sum(credit_amount)=${payout_amount}  (must be equal)`);
    say(`   kobo total=${totalKobo}  legs=${legs.map(l => l.kobo).join(' + ')}`);

    const r = await call('POST', '/payout-receptor/payout', {
      service_type: 'Disbursement',
      service_payload: {
        batch_reference, payout_amount, currency: 'NGN',
        transaction_pin: PIN || undefined,
        payout_beneficiaries: beneficiaries.map(b => ({ ...b, transaction_type: 'nuban', currency: 'NGN' })),
      },
    });
    show('payout (3 legs)', r);

    say('   polling per-leg status for 20s (query-before-retry — a timeout means UNKNOWN, never retry)...');
    for (let i = 0; i < 4; i++) {
      await new Promise(res => setTimeout(res, 5000));
      const s = await call('GET',
        `/payaza-account/api/v1/mainaccounts/merchant/transaction/${beneficiaries[0].transaction_reference}`);
      show(`status poll ${i + 1}`, s);
      const st = JSON.stringify(s.json || '');
      if (/NIP_SUCCESS|NIP_FAILURE|SUCCESSFUL|FAILED/i.test(st)) { say('   -> reached a terminal state.'); break; }
    }
  },
};

tests.C = {
  title: 'Is name enquiry REAL NIBSS resolution, or a canned stub in test mode?',
  why: 'Your hero beat is a real bank name appearing. If test mode stubs it, you must say so on stage.',
  async run() {
    if (!PROBE_ACCOUNTS.length) { say('   ~ set PROBE_ACCOUNT_1..3 to bankCode:accountNumber:ExpectedName'); return; }
    for (const a of PROBE_ACCOUNTS) {
      const r = await call('POST', '/payaza-account/api/v1/mainaccounts/merchant/provider/enquiry', {
        currency: 'NGN', bank_code: a.bank_code, account_number: a.account_number,
      });
      show(`enquiry ${a.bank_code}/${a.account_number} (expect ${a.expect})`, r);
    }
    say('   >>> If every account returns the same name, or a placeholder, it is STUBBED.');
    say('   >>> Then: pre-resolve at soundcheck, fire the live call anyway, and label it honestly.');
  },
};

tests.D = {
  title: 'Are OPay / PalmPay / Moniepoint / Kuda actually PAYOUT-CAPABLE?',
  why: 'Resolvable != payable. Nano creators are on wallets, not tier-1 banks.',
  async run() {
    const r = await call('GET', '/payaza-account/api/v1/mainaccounts/merchant/banks/NGN', null, { raw: true });
    if (r.skipped || !r.text) { show('banks/NGN', r); return; }
    let list = [];
    try {
      const j = JSON.parse(r.text);
      list = j?.data ?? j?.banks ?? (Array.isArray(j) ? j : []);
    } catch { /* ignore */ }
    say(`   OK banks/NGN [${r.status}] ${r.ms}ms — ${list.length} banks returned`);
    const want = ['opay', 'palmpay', 'moniepoint', 'kuda', 'gtbank', 'guaranty', '78', 'fidelity', 'globus'];
    for (const w of want) {
      const hits = list.filter(b => JSON.stringify(b).toLowerCase().includes(w));
      say(`   ${hits.length ? 'FOUND  ' : 'MISSING'} ${w.padEnd(12)} ${hits.slice(0, 2).map(h => JSON.stringify(h)).join(' ')}`);
    }
  },
};

tests.E = {
  title: 'Kobo arithmetic — payout_amount must equal sum(credit_amount) EXACTLY',
  why: 'Breaks the first time a fee lands on a kobo. Test the awkward number, not the clean one.',
  async run() {
    for (const amt of [60001, 60000.01, 33333.33, 100.03]) {
      const { totalKobo, legs, remainder } = splitKobo(amt, [{ pct: 45 }, { pct: 30 }, { pct: 25 }]);
      const sum = legs.reduce((a, l) => a + l.kobo, 0);
      const naira = legs.map(l => (l.kobo / 100).toFixed(2));
      const okSum = sum === totalKobo;
      const okNaira = Math.abs(naira.reduce((a, n) => a + Number(n), 0) - amt) < 1e-9;
      say(`   ₦${String(amt).padEnd(10)} kobo=${totalKobo} legs=${legs.map(l => l.kobo).join('+')}=${sum} ` +
          `remainder=${remainder} -> ${naira.join(' + ')}   ${okSum && okNaira ? 'PASS' : 'FAIL'}`);
    }
    say('   >>> Local only, no network. Remainder always goes to the largest share, deterministically.');
    try { splitKobo(1000, [{ pct: 50 }, { pct: 30 }]); say('   FAIL: 80% total was accepted'); }
    catch (e) { say(`   PASS: shares not totalling 100 are rejected — "${e.message}"`); }
  },
};

tests.F = {
  title: 'Does ONE invalid bank_code reject the WHOLE batch?',
  why: 'Partial-failure semantics are undocumented. If the batch rejects, you must chunk.',
  async run() {
    if (!PROBE_ACCOUNTS.length) { say('   ~ needs PROBE_ACCOUNT_1. Skipping.'); return; }
    const good = PROBE_ACCOUNTS[0];
    const legs = [
      { credit_amount: 100, account_number: good.account_number, bank_code: good.bank_code },
      { credit_amount: 100, account_number: good.account_number, bank_code: '999999' },  // deliberately bad
      { credit_amount: 100, account_number: good.account_number, bank_code: good.bank_code },
    ].map((l, i) => ({
      ...l, transaction_type: 'nuban', currency: 'NGN',
      account_name: good.expect, narration: safeNarration(`probe F leg ${i + 1}`),
      transaction_reference: makeRef('BF'),
    }));
    const r = await call('POST', '/payout-receptor/payout', {
      service_type: 'Disbursement',
      service_payload: {
        batch_reference: makeRef('BF'), payout_amount: 300, currency: 'NGN',
        transaction_pin: PIN || undefined, payout_beneficiaries: legs,
      },
    });
    show('payout with 1 bad bank_code of 3', r);
    say('   >>> Whole batch rejected  -> chunk into single-leg calls, or validate bank_code pre-flight.');
    say('   >>> Only leg 2 failed     -> per-leg state machine is enough.');
  },
};

tests.G = {
  title: 'Reference bounds + is a REUSED reference rejected?',
  why: 'That rejection is your only idempotency — Payaza provides none.',
  async run() {
    say(`   generated ref: "${makeRef()}" (${makeRef().length} chars — inside the 10..15 window)`);
    if (!PROBE_ACCOUNTS.length) { say('   ~ needs PROBE_ACCOUNT_1 for the reuse test. Skipping network half.'); return; }
    const a = PROBE_ACCOUNTS[0];
    const dupe = makeRef('DUP');
    const mk = () => ({
      service_type: 'Disbursement',
      service_payload: {
        batch_reference: makeRef('BD'), payout_amount: 100, currency: 'NGN',
        transaction_pin: PIN || undefined,
        payout_beneficiaries: [{
          credit_amount: 100, account_number: a.account_number, bank_code: a.bank_code,
          account_name: a.expect, transaction_type: 'nuban', currency: 'NGN',
          narration: safeNarration('probe G idempotency'), transaction_reference: dupe,
        }],
      },
    });
    show('first send', await call('POST', '/payout-receptor/payout', mk()));
    show('SAME transaction_reference again', await call('POST', '/payout-receptor/payout', mk()));
    say('   >>> If the second succeeds, you can DOUBLE-PAY on a retry. Never retry on timeout —');
    say('   >>> query status first, and keep the retry button disabled until a terminal state.');
  },
};

tests.H = {
  title: 'Narration limits: 26 chars, an em dash, a diacritic',
  why: 'Song titles carry apostrophes and diacritics. A failed leg on stage looks like theft.',
  async run() {
    const cases = ['This narration is 26 chars', 'Beat fee — Ìpín session', "Producer's cut 60%", 'Ìbàdàn'];
    for (const c of cases) {
      const folded = safeNarration(c);
      say(`   "${c}"`);
      say(`      -> "${folded}"  (${folded.length} chars, ascii=${/^[\x20-\x7e]*$/.test(folded)})`);
    }
    say('   >>> ASCII-fold and truncate SERVER-SIDE before every payout. Never trust the UI.');
  },
};

tests.I = {
  title: 'Dynamic VA on bank_code 1067 — provisioned? amount validation honoured? real TTL?',
  why: 'Amount validation exists only on 1067 and 140. Fidelity (117) silently ignores the fields.',
  async run() {
    for (const bank_code of ['1067', '117', '140']) {
      const r = await call('POST', '/merchant-collection/merchant/virtual_account/generate_virtual_account', {
        account_reference: makeRef('VB'),
        customer_first_name: 'Probe', customer_last_name: 'Bank' + bank_code,
        customer_email: 'probe@example.com', customer_phone_number: '08000000000',
        bank_code, transaction_amount: 60001, has_amount_validation: true,
        expiry_time: 480, currency: 'NGN',
      });
      show(`generate VA bank_code=${bank_code}`, r);
    }
    say('   >>> Note the ACTUAL expiry returned vs the 480 requested. Docs say default 30, ceiling 480.');
    say('   >>> Terminal states for VAs are only Completed and Initialized — there is no Failed.');
  },
};

tests.J = {
  title: 'Split Settlements with THREE SSA_ codes — the undocumented remainder rule',
  why: 'You will NOT ship this. Test it so you can report a finding on stage instead of an excuse.',
  async run() {
    if (PROBE_ACCOUNTS.length < 2) { say('   ~ needs 2+ PROBE_ACCOUNTs. Skipping.'); return; }
    const codes = [];
    for (const [i, a] of PROBE_ACCOUNTS.entries()) {
      const r = await call('POST', '/settlement/settlement/merchant/split-account', {
        account_no: a.account_number, account_name: a.expect, bank_code: a.bank_code,
        name: `Probe split ${i + 1}`, email: `probe${i + 1}@example.com`,
        currency: 'NGN', country: 'NGA',
        // TRAP: split_value is what YOU RETAIN, not what the beneficiary receives.
        split_type: 'PERCENTAGE', split_value: 20,
      });
      show(`create split-account ${i + 1}`, r);
      const code = r.json?.data?.code ?? r.json?.code;
      if (code) codes.push(code);
    }
    say(`   >>> codes created: ${codes.join(', ') || 'none'}`);
    say('   >>> THE QUESTION: with N>1 beneficiaries each carrying split_value, is the value SUMMED,');
    say('   >>> or does each claim "the remainder"? Undocumented. Record the answer verbatim —');
    say('   >>> reporting a negative result here is the single most credible thing you can say to');
    say('   >>> an infrastructure judge. Also check whether split_accounts works on a VA collection');
    say('   >>> at all, or only on Checkout: if VA collections support it, custody disappears in v2.');
  },
};

tests.K = {
  title: 'Rate limits on 20 sequential name enquiries',
  why: 'Undocumented. Your signing screen fires one per keystroke if you do not debounce.',
  async run() {
    if (!PROBE_ACCOUNTS.length) { say('   ~ needs PROBE_ACCOUNT_1. Skipping.'); return; }
    const a = PROBE_ACCOUNTS[0];
    let throttled = 0, slowest = 0;
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/payaza-account/api/v1/mainaccounts/merchant/provider/enquiry', {
        currency: 'NGN', bank_code: a.bank_code, account_number: a.account_number,
      });
      slowest = Math.max(slowest, r.ms || 0);
      if (r.status === 429 || /rate|throttl|too many/i.test(r.text || '')) { throttled++; say(`   req ${i + 1}: THROTTLED [${r.status}]`); }
      else if (!r.ok) say(`   req ${i + 1}: ERR [${r.status}] ${(r.text || '').slice(0, 120)}`);
    }
    say(`   >>> ${throttled}/20 throttled, slowest ${slowest}ms.`);
    say('   >>> Regardless of the result: debounce 400ms, cache by bank_code+account_number, cap 2-3 req/s.');
  },
};

tests.L = {
  title: 'Is transaction_pin set, and is postNoDebit clear?',
  why: 'Both silently block EVERY payout. Discover on day 1, not day 6.',
  async run() {
    const r = await call('GET', '/payaza-account/api/v1/mainaccounts/merchant/enquiry/main', null, { raw: true });
    show('enquiry/main', r);
    const t = (r.text || '').toLowerCase();
    say(`   transaction_pin env var set: ${PIN ? 'YES' : 'NO — payouts will fail'}`);
    if (t.includes('postnodebit') || t.includes('pnd')) {
      say('   >>> A postNoDebit / PND flag is present in the response. Read it. If set, email');
      say('   >>> support@payaza.africa to lift it — this is required after ANY PIN reset, and it');
      say('   >>> is a multi-hour turnaround you cannot absorb on demo morning.');
    } else {
      say('   >>> No PND flag surfaced. Confirm in the dashboard anyway (Settings -> Developers).');
    }
    say('   >>> LIVE payouts also require server IP whitelisting. Test mode does not. Whitelist the');
    say('   >>> static-egress payout host on day 1 — Vercel serverless egress rotates and will fail.');
  },
};

/* ---------------------------------------------------------------- main ---- */

const ORDER = ['A','B','C','D','E','F','G','H','I','J','K','L'];
const argv = process.argv.slice(2);

if (argv.includes('--list')) {
  console.log('\nPayaza Day-1 Probe — tests\n');
  for (const k of ORDER) console.log(`  ${k}  ${tests[k].title}`);
  console.log('\nRun:  node probe.mjs A B      (the two that decide the architecture)\n');
  process.exit(0);
}

const selected = argv.filter(a => ORDER.includes(a.toUpperCase())).map(a => a.toUpperCase());
const toRun = selected.length ? selected : ORDER;

say('# Payaza Day-1 Probe — results');
say('');
say(`Run at:      ${new Date().toISOString()}`);
say(`Base URL:    ${BASE}`);
say(`Tenant:      test  (X-TenantID header, not the URL)`);
say(`Public key:  ${PUBLIC_KEY ? PUBLIC_KEY.slice(0, 12) + '…' : 'NOT SET — network tests will skip'}`);
say(`Payout PIN:  ${PIN ? 'set' : 'NOT SET'}`);
say(`Accounts:    ${PROBE_ACCOUNTS.length} configured`);
say(`Tests:       ${toRun.join(', ')}`);
say('');

for (const k of toRun) {
  const t = tests[k];
  say('');
  say('---');
  say('');
  say(`## ${k}. ${t.title}`);
  say('');
  say(`*${t.why}*`);
  say('');
  say('```');
  try { await t.run(); }
  catch (e) { say(`   FATAL in test ${k}: ${e?.stack || e}`); }
  say('```');
}

say('');
say('---');
say('');
say('## What to do with this');
say('');
say('Keep the failures. A negative result reported honestly on stage — "we tested Split Settlements,');
say('here is what the multi-beneficiary remainder actually does" — is worth more than a feature, in');
say('front of a judge who wrote the API.');

const outDir = join(HERE, 'results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(outDir, `probe-${stamp}.md`);
writeFileSync(outFile, log.join('\n') + '\n');
console.log(`\n\nResults written to ${outFile}\n`);
