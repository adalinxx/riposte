// Riposte as a reader meets it now: the deployed hosts, the deployed fee
// sponsor and the trial chain, not a private stack. A new account with no
// coins grinds shares for the sponsor, has it price and co-sign a comment on
// a test page, sends it to iad, waits for it to land, and reads it back from
// ams. Then it reads a known account's Moniker card and photo from ams, as
// the widget shows an author. Each step that fails says which, and how long
// it was given.
//
//   node e2e/live.mjs
//
// It posts one real comment, under adalinxx.github.io/riposte/live-check.
import { createHash } from "node:crypto";
import * as sdk from "../vendor/lattice-sdk.js";
import { createRiposte } from "../src/index.mjs";
import * as r from "../src/records.mjs";
import { transaction } from "../src/wallet.mjs";
import { createMoniker } from "../vendor/moniker/index.mjs";
import { authorName } from "../widget/author.mjs";

const NODE = "https://lattice-testnet-apps-iad.fly.dev";
const SPONSOR = "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";
const SECOND = "https://lattice-testnet-apps-ams.fly.dev";
const CHAIN = ["Nexus", "testnet", "riposte-1fab4d"];
const SITE = "adalinxx.github.io";
const PAGE = "adalinxx.github.io/riposte/live-check";
// How long each step is given. A deploy restarts the sponsor for a minute or
// two; blocks are about 2.5 minutes apart.
const UNPRICEABLE_MINUTES = 5;
const LAND_MINUTES = 20;
const SECOND_MINUTES = 5;
// An account with a card and photo on Moniker (Nexus/moniker), set in a live trial.
const KNOWN = "bafyreihpcfcqbxecznct6ryuqfo3xbn6sakrwfos55empvx7gxec75ywyu";

const started = Date.now();
let stepStarted = started;
const minutes = (since) => ((Date.now() - since) / 60_000).toFixed(1);
const log = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
function step(name) {
  stepStarted = Date.now();
  log(name);
}
const fail = (message) => {
  throw new Error(`${message} (after ${minutes(started)} min in all)`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(path, body) {
  const deadline = Date.now() + UNPRICEABLE_MINUTES * 60_000;
  const since = Date.now();
  for (;;) {
    const response = await fetch(`${SPONSOR}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    if (response.ok) return JSON.parse(text);
    // Busy or unpriceable: the sponsor can't sign now. A restart passes; an hour of it is an outage.
    if (response.status === 503 && Date.now() < deadline) {
      await sleep(5000);
      continue;
    }
    if (response.status === 503) fail(`sponsor ${/unpriceable/.test(text) ? "unpriceable" : `refusing (${text.trim()})`} for ${minutes(since)} min`);
    throw Object.assign(new Error(`sponsor ${path}: ${response.status} ${text.trim()}`), { status: response.status });
  }
}

/** The nonces in `work`'s range whose SHA-256 over its prefix and the nonce (8 bytes, big-endian) is at or under its share target. */
function* shares(work) {
  const prefix = Buffer.from(work.prefixHex, "hex");
  const target = BigInt(`0x${work.shareTarget}`);
  const input = Buffer.alloc(prefix.length + 8);
  prefix.copy(input);
  for (let n = BigInt(work.startNonce), end = n + BigInt(work.count); n < end; n++) {
    input.writeBigUInt64BE(n, prefix.length);
    if (BigInt(`0x${createHash("sha256").update(input).digest("hex")}`) <= target) yield n;
  }
}

/** `draft` with the sponsor's fee debit and signature, earned with shares of work, as Selfhold's window does. */
async function sponsored(draft, fund) {
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  let client;
  let ground = 0;
  for (let round = 0; round < 20; round++) {
    if (client) {
      try {
        const answer = await ask("sponsor", { client, fund, transaction: { signatures: {}, body: toWire(draft) } });
        log(`  co-signed after ${ground} shares`);
        return { body: fromWire(answer.transaction.body), signatures: answer.transaction.signatures };
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) client = undefined;
        else if (error.status !== 402) throw error;
      }
    }
    const work = await ask("work", { ...(client && { client }), chain: CHAIN.join("/") });
    client = work.client;
    for (const nonce of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(nonce) });
        ground++;
        if (BigInt(credit) >= BigInt(work.fee)) break;
      } catch (error) {
        // Stale work: the chain moved on. Ask again.
        if (error.status === 400 || error.status === 410) break;
        throw error;
      }
    }
  }
  fail(`sponsor took ${ground} shares over 20 rounds and never co-signed`);
}

async function nonceAt(address) {
  const response = await fetch(`${NODE}/api/state/account/${address}?chainPath=${CHAIN.join("/")}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return 0n;
  if (!response.ok) throw new Error(`account: HTTP ${response.status}`);
  return BigInt((await response.json()).nonce ?? 0);
}

const me = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const page = await r.pageKey(SITE, PAGE);
const text = `Live check ${new Date().toISOString()}`;
const write = r.comment(page, me.address, { text, name: "live check" });
log(`reader ${me.address}, comment ${write.id} on ${PAGE}`);

step("1. the sponsor prices and co-signs the comment");
const { body, signatures } = await sponsored(transaction({ owner: me.address, actions: write.actions, nonce: 0n, chainPath: CHAIN }), r.fundPrefixes(r.siteOf(page)));
log(`  sponsored in ${minutes(stepStarted)} min`);

step("2. iad takes it");
const { publicKey, signature } = sdk.signTransactionBody(body, me.privateKey);
const submitted = await fetch(`${NODE}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ ...signatures, [publicKey]: signature }, body)), signal: AbortSignal.timeout(30_000) });
const answer = await submitted.text();
if (!submitted.ok) fail(`iad refused the comment: ${submitted.status} ${answer.trim()}`);
log(`  ${submitted.status} ${answer.trim().slice(0, 200)}`);

step("3. it lands");
for (let deadline = Date.now() + LAND_MINUTES * 60_000; ; ) {
  const nonce = await nonceAt(me.address).catch((error) => (log(`  ${error.message}`), 0n));
  if (nonce >= 1n) break;
  if (Date.now() > deadline) fail(`not landed after ${minutes(stepStarted)} min`);
  await sleep(15_000);
}
log(`  landed in ${minutes(stepStarted)} min`);

step("4. ams has it");
const second = createRiposte({ sdk, chain: CHAIN, nodes: [SECOND], freshFor: 0 });
const key = r.commentKey(page, me.address, write.id);
let seen;
for (let deadline = Date.now() + SECOND_MINUTES * 60_000; ; ) {
  try {
    const value = await (await second.state({ fresh: true })).get(key);
    seen = value === undefined ? "nothing" : r.parseComment(value);
    if (seen?.text === text) break;
  } catch (error) {
    seen = error.message;
  }
  if (Date.now() > deadline) fail(`ams doesn't have it after ${minutes(stepStarted)} min (reads ${JSON.stringify(seen)})`);
  await sleep(10_000);
}
log(`  ams reads it back in ${minutes(stepStarted)} min: ${JSON.stringify(seen)}`);

step("5. ams serves Moniker: a known author's card and photo");
const moniker = createMoniker({ sdk, nodes: [SECOND], freshFor: 0 });
// A read that fails is asked again for a few minutes, as the steps above are:
// a host fetching a photo it doesn't hold from peers can be slow once.
let handle, card, photo, problem;
for (let deadline = Date.now() + SECOND_MINUTES * 60_000; ; ) {
  try {
    [[handle], [card]] = await Promise.all([moniker.handlesOf([KNOWN]), moniker.profiles([KNOWN])]);
    if (card?.name !== "Live Trial" || !card.avatar) problem = `the known card reads ${JSON.stringify(card)}`;
    else if (!(photo = await moniker.photo(card.avatar))) problem = `photo ${card.avatar} isn't one the widget shows`;
    else break;
  } catch (error) {
    problem = `Moniker unread: ${error.message}`;
  }
  if (Date.now() > deadline) fail(`${problem}, for ${minutes(stepStarted)} min`);
  await sleep(10_000);
}
log(`  shown as ${JSON.stringify(authorName({ address: KNOWN, handle }))}, with a ${photo.bytes.length}-byte ${photo.type}`);
log(`live check passed in ${minutes(started)} min`);
