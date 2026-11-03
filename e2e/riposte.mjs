// Riposte against a real node, with no coins: a private host mines Nexus and
// a Riposte chain launched from chain/spec.json with the built policy, with
// fast blocks. The host takes no fee under 1, as the shared testnet hosts
// do, so nothing is free; a fee sponsor (lattice-sponsor) pays every fee in
// exchange for shares of work this script grinds, as Selfhold's window does
// in a page. Alice, Bob and the moderator never hold a coin.
//
// Alice comments under a page; a zero-fee comment of hers is refused. Bob
// replies and likes. Another page sees none of it. The moderator hides one
// comment and blocks an account. Forging, editing, deleting another's
// comment and oversized comments are refused even with the fee paid. Then
// Alice deletes her comment and Bob's reply shows its parent is gone.
//
//   npm run build:policy
//   LATTICE=<lattice-node>/.build/debug/lattice node e2e/riposte.mjs
//
// LATTICE_SPONSOR names lattice-sponsor if it isn't beside LATTICE.
// E2E_KEEP=<port> then serves this repository on <port>, its demo page
// reading this node, until interrupted.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "../vendor/lattice-sdk.js";
import { createRiposte } from "../src/index.mjs";
import * as r from "../src/records.mjs";
import { transaction } from "../src/wallet.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const RIPOSTE = ["Nexus", "riposte"];
const [listen, rpc, publicRead, sponsorPort] = [25071, 29420, 29421, 29422];
const node = `http://127.0.0.1:${publicRead}`;
const sponsorURL = `http://127.0.0.1:${sponsorPort}`;

const root = mkdtempSync(`${tmpdir()}/riposte-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}
/** A chain spec with 2-second blocks and no premine, written next to the node. */
function fast(file, name) {
  const out = `${root}/${name}-spec.json`;
  writeFileSync(out, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), targetBlockTime: 2000, premine: 0 }));
  return out;
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function accountState(chain, address) {
  const response = await fetch(`${node}/api/state/account/${address}?chainPath=${chain.join("/")}`, { cache: "no-store" });
  return response.ok ? await response.json() : {};
}
const used = new Map(); // "<chain> <account>" → the nonce after the last one sent
/**
 * The next nonce for `who` on `chain`. A host takes one waiting write per
 * account and no nonce ahead of the chain, so this waits for the last write
 * sent to land first, as a wallet does.
 */
async function nonce(chain, who) {
  const key = `${chain.join("/")} ${who.address}`;
  const want = used.get(key) ?? 0n;
  const next = await until(`${who.address.slice(-6)}'s last write on ${chain.join("/")} to land`, async () => {
    const n = BigInt((await accountState(chain, who.address)).nonce ?? 0);
    return n >= want ? n + 1n : false;
  });
  used.set(key, next);
  return next - 1n;
}
/** Gives back a nonce a refused write didn't use. */
const unuse = (chain, who, n) => used.set(`${chain.join("/")} ${who.address}`, n);
const balance = async (chain, address) => BigInt((await accountState(chain, address)).balance ?? 0);

async function submit(signatures, body) {
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload(signatures, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

// ---------------------------------------------------------------- the fee sponsor, as a wallet uses it

async function ask(path, body) {
  const response = await fetch(`${sponsorURL}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status} ${text}`), { status: response.status });
  return JSON.parse(text);
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

const clients = new Map(); // account → the sponsor's token for it
let sharesGround = 0;
/** `draft` (fee 0, one signer) with the sponsor's fee debit and signature, earned with work first when the credit is short. */
async function sponsored(who, draft) {
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  const sign = async () => {
    const answer = await ask("sponsor", { client: clients.get(who.address), transaction: { signatures: {}, body: toWire(draft) } });
    const body = fromWire(answer.transaction.body);
    // Only the sponsor's debit and signature added.
    assert.deepEqual(body.signers, [who.address, sponsor.address]);
    assert.deepEqual(body.actions, draft.actions);
    assert.ok(body.accountActions.every((a) => a.owner === sponsor.address && a.delta < 0n));
    return { body, signatures: answer.transaction.signatures };
  };
  for (let round = 0; ; round++) {
    if (clients.has(who.address)) {
      try {
        return await sign();
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) clients.delete(who.address);
        else if (error.status !== 402) throw error;
      }
    }
    if (round > 20) throw new Error("the sponsor took none of this work");
    let work;
    try {
      work = await ask("work", { ...(clients.has(who.address) && { client: clients.get(who.address) }), chain: draft.chainPath.join("/") });
    } catch (error) {
      // A token the sponsor no longer knows: start over with a new one, as Selfhold does.
      if (error.status === 400 && /client token/.test(error.message)) {
        clients.delete(who.address);
        continue;
      }
      if (error.status !== 503) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    clients.set(who.address, work.client);
    let found = 0;
    for (const nonce of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(nonce) });
        sharesGround++;
        if (BigInt(credit) >= BigInt(work.fee) || ++found >= Number(work.sharesForFee)) break;
      } catch (error) {
        // Stale work: the chain moved on. Ask again.
        if (error.status === 400 || error.status === 410) break;
        throw error;
      }
    }
  }
}

/** `actions` on `chain` by `who`, its fee paid by the sponsor; the node's answer. */
async function send(chain, who, { actions }) {
  const n = await nonce(chain, who);
  const draft = transaction({ owner: who.address, actions, nonce: n, chainPath: chain });
  let result;
  try {
    const { body, signatures } = await sponsored(who, draft);
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    result = await submit({ ...signatures, [publicKey]: signature }, body);
  } catch (error) {
    unuse(chain, who, n);
    throw error;
  }
  if (!result.ok) unuse(chain, who, n);
  return result;
}

/** `actions` by `who` with no fee and no sponsor, as an app that ignores fees would send them. */
async function sendFree(chain, who, { actions }) {
  const n = await nonce(chain, who);
  const body = transaction({ owner: who.address, actions, nonce: n, chainPath: chain });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const result = await submit({ [publicKey]: signature }, body);
  if (!result.ok) unuse(chain, who, n);
  return result;
}

async function admitted(label, chain, who, write) {
  const result = await send(chain, who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
  console.log(`  admitted: ${label}`);
}

/** Refused by the node; with `sponsor`, refused even with its fee paid, so by the policy. */
async function refused(label, who, write, { chain = RIPOSTE } = {}) {
  let result;
  try {
    result = await send(chain, who, write);
  } catch (error) {
    // The sponsor's own checks may refuse it first; either way nothing lands.
    result = { ok: false, status: error.status, text: error.message };
  }
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${String(result.text).trim().slice(0, 120)})`);
}

/** A wallet holding `who`'s key, as Selfhold's window answers the library: it has the fee sponsored, signs and sends. */
const walletOf = (who) => ({
  address: async () => who.address,
  writeRecords: async (request) => {
    assert.equal(request.fee, undefined, "the app leaves the fee to the wallet");
    const result = await send(request.chainPath, who, request);
    if (!result.ok) throw new Error(`${result.status} ${result.text}`);
    return { transactionCID: "sent" };
  },
});

const [alice, bob, mod] = [account(), account(), account()];

const as = (who) => ({ wallet: walletOf(who) });

const riposte = createRiposte({ sdk, chain: RIPOSTE, nodes: [node], freshFor: 0 });

/** Starts mining; another suite on this machine may hold the miner a while. */
async function mine() {
  for (let attempt = 0; ; attempt++) {
    try {
      return lattice("mine", "start");
    } catch (error) {
      if (!/already running/i.test(`${error.stderr}${error.stdout}${error.message}`) || attempt >= 10) throw error;
      console.log("  mining is already running elsewhere: waiting a minute");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}

/** E2E_KEEP=<port>: a lively thread, then this repository served on <port>, reading this node, until interrupted. */
async function keep(page) {
  const { id: q } = await page.comment({ name: "Grace", text: "Does this work with Hugo? I'd rather not run a database for comments on a static site." }, as(mod));
  await page.comment({ name: "Ada", text: "Yes: it's one <script> tag in the footer partial. I added it to mine in a minute.", reply: { author: mod.address, id: q } }, as(alice));
  await page.comment({ text: "No sign-up and no captcha either. Posting this took my laptop a second of work.\nhttps://example.com/notes" }, as(bob));
  await until("the extra comments land", async () => (await page.comments()).length >= 5);
  const { createServer } = await import("node:http");
  const port = Number(process.env.E2E_KEEP);
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };
  const repo = here("..");
  createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const file = join(repo, url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname);
    if (!file.startsWith(repo)) return response.writeHead(403).end();
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "Content-Type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream", "Access-Control-Allow-Origin": "*" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  }).listen(port, "127.0.0.1");
  const query = `node=${encodeURIComponent(node)}&chain=${RIPOSTE.join("/")}&sponsor=${encodeURIComponent(sponsorURL)}&moderators=${mod.address}&page=${encodeURIComponent(r.pageName("https://blog.example.com/posts/hello-world/"))}`;
  writeFileSync(`${root}/keep.json`, JSON.stringify({ demo: `http://127.0.0.1:${port}/demo/?${query}`, node, chain: RIPOSTE.join("/"), sponsor: sponsorURL, alice: alice.address, bob: bob.address, mod: mod.address }));
  console.log(`KEEP ${root}/keep.json`);
  console.log(`demo: http://127.0.0.1:${port}/demo/?${query}`);
  await new Promise(() => {});
}

let sponsor, sponsorChild;
function stop() {
  sponsorChild?.kill();
  try {
    lattice("mine", "stop");
  } catch {}
  try {
    lattice("down");
  } catch {}
}
// Stopped from outside (E2E_KEEP, or a test that ran this): leave nothing running.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => (stop(), process.exit(130)));
try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    // As the shared testnet hosts: a fee of at least 1, so no write is free.
    topology.minRelayFee = 1;
    topology.publicReadExpensiveRate = 10000;
    topology.publicReadRate = 10000;
    topology.publicReadMaxRate = 100000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", RIPOSTE.join("/"), "--spec", fast(here("../chain/spec.json"), "riposte"), "--policy-module", here("../chain/riposte_policy.wasm"));

  // The sponsor is paid the chain's block rewards, and so holds coins there to pay fees with.
  const keyFile = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", keyFile]);
  sponsor = JSON.parse(readFileSync(keyFile, "utf8"));
  configure((topology) => {
    topology.mine.recipients = { Nexus: account().address, [RIPOSTE.join("/")]: sponsor.address };
  });
  lattice("up");
  await mine();
  await until("the sponsor's first coins", async () => (await balance(RIPOSTE, sponsor.address)) > 10n);
  const log = openSync(`${root}/sponsor.log`, "a");
  sponsorChild = spawn(process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor"), [
    "--node", `http://127.0.0.1:${rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", keyFile,
    "--share-work", "2^12", "--fee", "1", "--port", String(sponsorPort),
  ], { stdio: ["ignore", log, log] });
  await until("the sponsor prices Riposte", async () => (await ask("work", { chain: RIPOSTE.join("/") }), true), 120);
  console.log(`Riposte launched; the sponsor (${sponsor.address.slice(-6)}) pays fees for work`);

  const page = await riposte.page("https://blog.example.com/posts/hello-world/");
  const elsewhere = await riposte.page({ name: "blog.example.com/posts/another" });
  assert.equal(page.key, (await riposte.page("http://www.blog.example.com/posts/hello-world?ref=hn#comments")).key);

  // ------------------------------------------------------------ commenting with no coins
  const free = await sendFree(RIPOSTE, alice, r.comment(page.key, alice.address, { text: "free?" }));
  assert.ok(!free.ok, "a zero-fee write was admitted: this run proves nothing about sponsors");
  console.log(`  refused: a zero-fee comment, unsponsored (${free.status})`);

  const { id: hello } = await page.comment({ text: "Lovely post. Where did you get the data?", name: "Alice" }, as(alice));
  console.log("  admitted: Alice comments through the library");
  await until("Alice's comment is mined", async () => (await page.comments()).length === 1);
  const first = { author: alice.address, id: hello };
  const { id: answer } = await page.comment({ text: "From the city's open data portal.", reply: first }, as(bob));
  await page.like(first, as(bob));
  await until("the reply and like are mined", async () => {
    const list = await page.comments();
    return list.length === 2 && list[0].likes.length === 1;
  });
  const list = await page.comments();
  assert.deepEqual(list.map((c) => [c.text, c.name, c.likes]), [
    ["Lovely post. Where did you get the data?", "Alice", [bob.address]],
    ["From the city's open data portal.", undefined, []],
  ]);
  assert.deepEqual(r.tree(list)[0].replies.map((c) => c.id), [answer]);
  assert.deepEqual(await elsewhere.comments(), []);
  console.log("  a comment, a reply and a like read back as a thread; another page has none");

  // ------------------------------------------------------------ moderation is marking
  const spam = (await page.comment({ text: "BUY CHEAP WATCHES" }, as(bob))).id;
  await until("the spam lands", async () => (await page.comments()).length === 3);
  await page.hide({ author: bob.address, id: spam }, as(mod));
  await page.block(alice.address, as(mod));
  await until("the marks land", async () => (await page.hidden([mod.address])).accounts.size === 1);
  const marks = await page.hidden([mod.address]);
  assert.deepEqual([...marks.comments], [`${bob.address}/${spam}`]);
  assert.deepEqual([...marks.accounts], [alice.address]);
  assert.equal((await page.comments()).length, 3, "a mark deletes nothing");
  await page.block(alice.address, as(mod), false);
  await until("the unblock lands", async () => (await page.hidden([mod.address])).accounts.size === 0);
  console.log("  the moderator hid a comment and blocked, then unblocked, an account; nothing was deleted");

  // ------------------------------------------------------------ what the policy refuses, fee paid or not
  const state = await riposte.state({ fresh: true });
  const aliceValue = await state.get(r.commentKey(page.key, alice.address, hello));
  await refused("Bob writing a comment as Alice", bob, { actions: [{ key: r.commentKey(page.key, alice.address, "forged"), newValue: JSON.stringify({ text: "forged" }) }] });
  await refused("Alice editing her comment", alice, { actions: [{ key: r.commentKey(page.key, alice.address, hello), oldValue: aliceValue, newValue: JSON.stringify({ text: "edited" }) }] });
  await refused("the moderator deleting Alice's comment", mod, { actions: [{ key: r.commentKey(page.key, alice.address, hello), oldValue: aliceValue }] });
  await refused("Bob hiding as the moderator", bob, { actions: [{ key: r.hideKey(mod.address, page.key, first), newValue: "1" }] });
  await refused("a comment over 10240 bytes", bob, { actions: [{ key: r.commentKey(page.key, bob.address, "big"), newValue: "x".repeat(10241) }] });

  // ------------------------------------------------------------ taking it back
  await page.remove(hello, as(alice));
  await until("the deletion is mined", async () => (await page.comments()).length === 2);
  const after = r.tree(await page.comments());
  assert.equal(after[0].missing, true);
  assert.deepEqual(after[0].replies.map((c) => c.id), [answer]);
  console.log("  admitted: Alice deletes her comment; Bob's reply shows its parent is gone");

  for (const [name, who] of [["Alice", alice], ["Bob", bob], ["The moderator", mod]]) {
    assert.equal(await balance(RIPOSTE, who.address), 0n, `${name} holds coins`);
  }
  console.log(`Alice, Bob and the moderator hold no coins; the sponsor paid every fee, for ${sharesGround} shares of work`);
  console.log("e2e passed");
  if (process.env.E2E_KEEP) await keep(page);
} finally {
  stop();
}
