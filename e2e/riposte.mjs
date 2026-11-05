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
// comment and oversized comments are refused even with the fee paid. A
// patron who holds coins tips Alice's comment from their balance; a tip whose
// author isn't credited, a self-tip, and a tip past the tipper's balance are
// refused. The blog lends the sponsor float: it sends the sponsor coins and
// claims them for its site's fund, and Bob's next comment there is held
// against that deposit; a claim signed by another key is refused, and a
// sponsor that sponsors funded sites only refuses a site with no fund. Then
// Alice deletes her comment and Bob's reply shows its parent is gone.
//
// The node hosts Moniker too, launched from adalinxx/moniker's spec and
// policy: the moderator claims @grace there and puts a photo, kept by the
// sponsor for work, on their card, and a reader reads both back by account.
//
//   npm run build:policy
//   LATTICE=<lattice-node>/.build/debug/lattice MONIKER=<moniker> node e2e/riposte.mjs
//
// LATTICE_SPONSOR names lattice-sponsor if it isn't beside LATTICE; it must
// sell storage. MONIKER is a checkout of adalinxx/moniker (default ~/src/moniker).
// E2E_KEEP=<port> then serves this repository on <port>, its demo page
// reading this node, until interrupted.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import * as sdk from "../vendor/lattice-sdk.js";
import { createMoniker } from "../vendor/moniker/index.mjs";
import { shortAccount } from "../src/account.mjs";
import { authorName } from "../widget/author.mjs";
import { createRiposte } from "../src/index.mjs";
import * as r from "../src/records.mjs";
import { transaction } from "../src/wallet.mjs";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const RIPOSTE = ["Nexus", "riposte"];
const MONIKER = ["Nexus", "moniker"];
const monikerRepo = process.env.MONIKER ?? join(homedir(), "src/moniker");
const POST = "https://blog.example.com/posts/hello-world/";
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

async function ask(path, body, at = sponsorURL) {
  const response = await fetch(`${at}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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

const clients = new Map(); // "<sponsor> <account>" → that sponsor's token for the account
let sharesGround = 0;
/** `draft` (fee 0, one signer) with the sponsor's fee debit and signature, earned with work first when the credit is short. */
async function sponsored(who, draft, fund, at = sponsorURL) {
  const client = `${at} ${who.address}`;
  const toWire = (body) => sdk.transactionPayload({}, body).transaction.body;
  const fromWire = (body) => ({ ...body, accountActions: body.accountActions.map((a) => ({ owner: a.owner, delta: BigInt(a.delta) })), nonce: BigInt(body.nonce) });
  const sign = async () => {
    // `fund`: the site's prefixes, for a sponsor with a fund for it; others ignore it.
    const answer = await ask("sponsor", { client: clients.get(client), transaction: { signatures: {}, body: toWire(draft) }, ...(fund && { fund }) }, at);
    const body = fromWire(answer.transaction.body);
    // Only the sponsor's debit and signature added.
    assert.deepEqual(body.signers, [who.address, sponsor.address]);
    assert.deepEqual(body.actions, draft.actions);
    assert.deepEqual(body.accountActions.slice(0, draft.accountActions.length), draft.accountActions);
    assert.ok(body.accountActions.slice(draft.accountActions.length).every((a) => a.owner === sponsor.address && a.delta < 0n));
    return { body, signatures: answer.transaction.signatures };
  };
  for (let round = 0; ; round++) {
    if (clients.has(client)) {
      try {
        return await sign();
      } catch (error) {
        if (error.status === 400 && /client token/.test(error.message)) clients.delete(client);
        // 402 is credit short of the fee, unless no fund backs the draft for a --funded-only sponsor.
        else if (error.status !== 402 || /notFunded/.test(error.message)) throw error;
      }
    }
    if (round > 20) throw new Error("the sponsor took none of this work");
    let work;
    try {
      work = await ask("work", { ...(clients.has(client) && { client: clients.get(client) }), chain: draft.chainPath.join("/") }, at);
    } catch (error) {
      // A token the sponsor no longer knows: start over with a new one, as Selfhold does.
      if (error.status === 400 && /client token/.test(error.message)) {
        clients.delete(client);
        continue;
      }
      if (error.status !== 503) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    clients.set(client, work.client);
    let found = 0;
    for (const nonce of shares(work)) {
      try {
        const { credit } = await ask("shares", { assignment: work.assignment, nonce: String(nonce) }, at);
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

/** `actions` (and `payments`, from `who`'s coins) on `chain` by `who`, its fee paid by the sponsor; the node's answer. */
async function send(chain, who, { actions, payments, fund }) {
  const n = await nonce(chain, who);
  const draft = transaction({ owner: who.address, actions, payments, nonce: n, chainPath: chain });
  let result;
  try {
    const { body, signatures } = await sponsored(who, draft, fund);
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    result = await submit({ ...signatures, [publicKey]: signature }, body);
  } catch (error) {
    unuse(chain, who, n);
    throw error;
  }
  if (!result.ok) unuse(chain, who, n);
  return result;
}

/** Grinds a sponsor's work on this machine, as a page does on a device: `hash(work, found, hashed)` for moniker-sdk. */
function hash(work, found, hashed) {
  let stopped = false;
  const done = (async () => {
    let count = 0;
    for (const nonce of shares(work)) {
      if (stopped) return;
      found(nonce);
      // Let the shares go out while the hashing runs on.
      if (++count % 4 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    hashed(Number(work.count));
  })();
  return { done, stop: () => (stopped = true) };
}

/** A `width` × `height` PNG of a soft gradient: a real picture, made here. */
function png(width, height) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = x / width, u = y / height;
      rows.set([Math.round(20 + 60 * u), Math.round(120 + 100 * t), Math.round(110 + 90 * (1 - t) * (1 - u))], row + 1 + x * 3);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
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
    // Payments (tips) come from coins only: no sponsor buys a shortfall with work here.
    if (request.payments) assert.equal(request.coinOnly, true, "a payment asks for coins only");
    const result = await send(request.chainPath, who, request); // actions, payments and fund
    if (!result.ok) throw new Error(`${result.status} ${result.text}`);
    return { transactionCID: "sent" };
  },
});

const [alice, bob, mod, patron] = [account(), account(), account(), account()];

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
  // The demo shows the blog post's thread, as an embed on the post would.
  const query = `node=${encodeURIComponent(node)}&chain=${RIPOSTE.join("/")}&sponsor=${encodeURIComponent(sponsorURL)}&moderators=${mod.address}&url=${encodeURIComponent(POST)}`;
  writeFileSync(`${root}/keep.json`, JSON.stringify({ demo: `http://127.0.0.1:${port}/demo/?${query}`, home: `http://127.0.0.1:${port}/`, post: POST, node, chain: RIPOSTE.join("/"), sponsor: sponsorURL, sponsorKey: `${root}/sponsor-key.json`, alice: alice.address, bob: bob.address, mod: mod.address }));
  console.log(`KEEP ${root}/keep.json`);
  console.log(`demo: http://127.0.0.1:${port}/demo/?${query}`);
  await new Promise(() => {});
}

let sponsor, sponsorChild, strictChild;
function stop() {
  sponsorChild?.kill();
  strictChild?.kill();
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
  lattice("child", "create", MONIKER.join("/"), "--spec", fast(join(monikerRepo, "chain/spec.json"), "moniker"), "--policy-module", join(monikerRepo, "chain/moniker_policy.wasm"));

  // The sponsor is paid the chain's block rewards, and so holds coins there to pay fees with.
  const keyFile = `${root}/sponsor-key.json`;
  execFileSync(process.env.LATTICE, ["key", "generate", "--out", keyFile]);
  sponsor = JSON.parse(readFileSync(keyFile, "utf8"));
  configure((topology) => {
    topology.mine.recipients = { Nexus: account().address, [RIPOSTE.join("/")]: sponsor.address, [MONIKER.join("/")]: sponsor.address };
  });
  lattice("up");
  await mine();
  await until("the sponsor's first coins", async () => (await balance(RIPOSTE, sponsor.address)) > 10n);
  const log = openSync(`${root}/sponsor.log`, "a");
  // --funds: a site may lend it float (see "a site's fund" below). Its funds and claims are kept beside --storage-file.
  const sponsorArgs = [
    "--node", `http://127.0.0.1:${rpc}`, "--cookie-file", `${root}/chains/Nexus/.cookie`, "--key", keyFile,
    "--share-work", "2^12", "--fee", "1", "--funds", "--storage-file", `${root}/sponsor-storage.json`,
  ];
  const sponsorBinary = process.env.LATTICE_SPONSOR || join(dirname(process.env.LATTICE), "lattice-sponsor");
  // It also keeps Moniker's photos for work, as the testnet sponsor does.
  const storage = ["--sell-storage", "--storage-rate", `${MONIKER.join("/")}=1000000`];
  sponsorChild = spawn(sponsorBinary, [...sponsorArgs, ...storage, "--port", String(sponsorPort)], { stdio: ["ignore", log, log] });
  await until("the sponsor prices Riposte", async () => (await ask("work", { chain: RIPOSTE.join("/") }), true), 120);
  await until("the sponsor prices Moniker", async () => (await ask("work", { chain: MONIKER.join("/") }), true), 120);
  console.log(`Riposte launched; the sponsor (${sponsor.address.slice(-6)}) pays fees for work`);

  const page = await riposte.page(POST);
  const elsewhere = await riposte.page({ name: "blog.example.com/posts/another", site: "blog.example.com" });
  assert.equal(page.key, (await riposte.page("http://www.blog.example.com/posts/hello-world?ref=hn#comments")).key);
  // Any address's thread (discuss/?url=) is the one an embed at that address shows: the
  // widget there keys the page by its own address, the discuss page by the one it's given.
  assert.equal(page.key, await r.pageKey(new URL(POST).host, r.pageName(POST)));
  assert.equal((await riposte.page({ name: r.pageName(POST), site: "www.blog.example.com" })).key, page.key);
  assert.notEqual((await riposte.page(POST.replace("blog.example.com", "blog.example.org"))).key.slice(0, 16), page.site);
  assert.deepEqual(page.fund, [`comment/${page.site}`, `like/${page.site}`, `tip/${page.site}`]);

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
  // The moderator mutes Bob for themselves: their own mark, not a block on their pages.
  await page.mute(bob.address, as(mod));
  await until("the mute lands", async () => (await page.muted(mod.address)).has(bob.address));
  assert.equal((await page.hidden([mod.address])).accounts.size, 0, "a mute is no block");
  await page.mute(bob.address, as(mod), false);
  await until("the unmute lands", async () => (await page.muted(mod.address)).size === 0);
  console.log("  the moderator hid a comment and blocked, then unblocked, an account; nothing was deleted");

  // ------------------------------------------------------------ what the policy refuses, fee paid or not
  const state = await riposte.state({ fresh: true });
  const aliceValue = await state.get(r.commentKey(page.key, alice.address, hello));
  await refused("Bob writing a comment as Alice", bob, { actions: [{ key: r.commentKey(page.key, alice.address, "forged"), newValue: JSON.stringify({ text: "forged" }) }] });
  await refused("Alice editing her comment", alice, { actions: [{ key: r.commentKey(page.key, alice.address, hello), oldValue: aliceValue, newValue: JSON.stringify({ text: "edited" }) }] });
  await refused("the moderator deleting Alice's comment", mod, { actions: [{ key: r.commentKey(page.key, alice.address, hello), oldValue: aliceValue }] });
  await refused("Bob hiding as the moderator", bob, { actions: [{ key: r.hideKey(mod.address, page.key, first), newValue: "1" }] });
  await refused("a comment over 10240 bytes", bob, { actions: [{ key: r.commentKey(page.key, bob.address, "big"), newValue: "x".repeat(10241) }] });

  // ------------------------------------------------------------ tips, from coins
  // The patron is sent coins from the sponsor's rewards, in a plain transfer the sponsor's key signs.
  const GIFT = 20n;
  {
    const n = await nonce(RIPOSTE, sponsor);
    const body = transaction({ owner: sponsor.address, actions: [], payments: [{ to: patron.address, amount: String(GIFT) }], fee: 1n, nonce: n, chainPath: RIPOSTE });
    const { publicKey, signature } = sdk.signTransactionBody(body, Uint8Array.from(Buffer.from(sponsor.privateKey, "hex")));
    const result = await submit({ [publicKey]: signature }, body);
    assert.ok(result.ok, `the patron's coins: ${result.status} ${result.text}`);
    await until("the patron's coins land", async () => (await balance(RIPOSTE, patron.address)) === GIFT);
  }
  const { id: tipped } = await page.tip(first, 5, as(patron));
  await until("the tip lands", async () => (await page.comments())[0].tips.count === 1);
  assert.deepEqual((await page.comments())[0].tips, { count: 1, total: 5n });
  assert.equal(await balance(RIPOSTE, alice.address), 5n, "Alice was paid the tip");
  assert.equal(await balance(RIPOSTE, patron.address), GIFT - 5n, "the tip came from the patron's coins; the sponsor paid the fee");
  console.log(`  admitted: the patron tips Alice's comment 5 coins from their balance (${tipped})`);

  await assert.rejects(page.tip(first, 1, as(bob)), (error) => error.code === "NotEnoughCoins");
  console.log("  refused by the library: Bob, with no coins, tipping");
  await assert.rejects(page.tip(first, 1, as(alice)), /your own comment/);
  const tipAt = (who, tid) => r.tipKey(page.key, first, who.address, tid);
  await refused("a tip its author isn't credited in full", patron, { actions: [{ key: tipAt(patron, "short1"), newValue: "5" }], payments: [{ to: alice.address, amount: "4" }] });
  await refused("a tip with no payment", patron, { actions: [{ key: tipAt(patron, "short2"), newValue: "1" }] });
  await refused("Alice tipping her own comment", alice, { actions: [{ key: tipAt(alice, "self1"), newValue: "5" }], payments: [{ to: alice.address, amount: "5" }] });
  await refused("a tip edited after it was paid", patron, { actions: [{ key: tipAt(patron, tipped), oldValue: "5", newValue: "6" }], payments: [{ to: alice.address, amount: "6" }] });
  assert.equal(await balance(RIPOSTE, alice.address), 5n);
  assert.equal(await balance(RIPOSTE, patron.address), GIFT - 5n);

  // ------------------------------------------------------------ a site's fund at the sponsor
  // The blog sends the sponsor coins, which the sponsor gave it first, and claims them for its site's fund.
  const blog = account();
  const fundState = async (fund) => {
    const response = await fetch(`${sponsorURL}/fund?chain=${RIPOSTE.join("/")}&${fund.map((p) => `prefix=${encodeURIComponent(p)}`).join("&")}`);
    assert.ok(response.ok, `GET /fund: ${response.status}`);
    const { deposit, held } = await response.json();
    return { deposit: BigInt(deposit), held: BigInt(held) };
  };
  assert.equal((await (await fetch(`${sponsorURL}/terms`)).json()).fundTo, sponsor.address, "deposits go to the sponsor's own address");
  assert.deepEqual(await fundState(page.fund), { deposit: 0n, held: 0n });
  const DEPOSIT = 10n;
  {
    const n = await nonce(RIPOSTE, sponsor);
    const body = transaction({ owner: sponsor.address, actions: [], payments: [{ to: blog.address, amount: String(DEPOSIT + 1n) }], fee: 1n, nonce: n, chainPath: RIPOSTE });
    const { publicKey, signature } = sdk.signTransactionBody(body, Uint8Array.from(Buffer.from(sponsor.privateKey, "hex")));
    const result = await submit({ [publicKey]: signature }, body);
    assert.ok(result.ok, `the blog's coins: ${result.status} ${result.text}`);
    await until("the blog's coins land", async () => (await balance(RIPOSTE, blog.address)) === DEPOSIT + 1n);
  }
  let depositCID;
  {
    const n = await nonce(RIPOSTE, blog);
    const body = transaction({ owner: blog.address, actions: [], payments: [{ to: sponsor.address, amount: String(DEPOSIT) }], fee: 1n, nonce: n, chainPath: RIPOSTE });
    const { publicKey, signature } = sdk.signTransactionBody(body, blog.privateKey);
    const result = await submit({ [publicKey]: signature }, body);
    assert.ok(result.ok, `the deposit: ${result.status} ${result.text}`);
    depositCID = JSON.parse(result.text).transactionCID;
  }
  // The claim, signed by one of the transfer's signers over the chain, the transfer and the fund's prefixes (sorted, as page.fund is).
  const claim = `lattice-sponsor-pay-fund:v1:${RIPOSTE.join("/")}:${depositCID}:${page.fund.join("\n")}`;
  const pay = (key) => ask("pay", { chain: RIPOSTE.join("/"), txCID: depositCID, signer: blog.address, signature: sdk.signPreimage(claim, key), fund: page.fund });
  // Until the transfer is deep enough the sponsor answers notIncluded or notDeepEnough; then a claim signed by Bob is refused.
  const forged = await until("the deposit is deep enough to claim", async () => {
    try {
      await pay(bob.privateKey);
      return { status: 200, message: "admitted" };
    } catch (error) {
      if (/notIncluded|notDeepEnough/.test(error.message)) return false;
      return error;
    }
  });
  assert.equal(forged.status, 400, `a claim signed by another key: ${forged.message}`);
  assert.match(forged.message, /invalidSignature/);
  console.log("  refused: claiming the blog's deposit with another key's signature");
  assert.equal(BigInt((await pay(blog.privateKey)).deposit), DEPOSIT);
  assert.deepEqual(await fundState(page.fund), { deposit: DEPOSIT, held: 0n });
  await assert.rejects(pay(blog.privateKey), (error) => error.status === 409);
  console.log(`  admitted: the blog claims its ${DEPOSIT}-coin deposit for its site's fund, once`);

  // Bob, who holds no coins, comments on another of the blog's posts: the sponsor holds the fee against the blog's fund.
  assert.deepEqual(elsewhere.fund, page.fund, "one fund for the whole site");
  await elsewhere.comment({ text: "Thanks for keeping comments open." }, as(bob));
  const backed = await fundState(page.fund);
  assert.equal(backed.deposit, DEPOSIT);
  assert.ok(backed.held > 0n && backed.held <= DEPOSIT, `the fund holds ${backed.held} of ${DEPOSIT}`);
  await until("Bob's funded comment lands", async () => (await elsewhere.comments()).length === 1);
  assert.equal(await balance(RIPOSTE, bob.address), 0n, "Bob paid for his comment in work");
  console.log(`  admitted: Bob's comment on the blog, its fee held against the blog's fund (${backed.held} of ${DEPOSIT})`);

  // A sponsor run --funded-only, keeping the same deposits, sponsors the blog and refuses a site with no fund.
  const strictURL = `http://127.0.0.1:${sponsorPort + 1}`;
  strictChild = spawn(sponsorBinary, [...sponsorArgs, "--funded-only", "--port", String(sponsorPort + 1)], { stdio: ["ignore", log, log] });
  await until("the funded-only sponsor prices Riposte", async () => (await ask("work", { chain: RIPOSTE.join("/") }, strictURL), true), 120);
  const unfunded = await riposte.page("https://unfunded.example.net/posts/1");
  /** Bob's comment on `on`, co-signed by the funded-only sponsor; only asked for, never sent. */
  const strictly = async (on) => {
    const n = await nonce(RIPOSTE, bob);
    unuse(RIPOSTE, bob, n);
    return sponsored(bob, transaction({ owner: bob.address, actions: r.comment(on.key, bob.address, { text: "hi" }).actions, nonce: n, chainPath: RIPOSTE }), on.fund, strictURL);
  };
  await assert.rejects(strictly(unfunded), (error) => error.status === 402 && /notFunded/.test(error.message));
  console.log("  refused by a funded-only sponsor: a comment on a site with no fund");
  assert.equal(Object.keys((await strictly(page)).signatures).length, 1);
  console.log("  admitted by a funded-only sponsor: a comment on the blog, which has a fund");

  // ------------------------------------------------------------ names and photos from Moniker
  // The moderator claims @grace and shows it, keeps a photo with the sponsor for work, and puts it on their card.
  const monikerAs = createMoniker({ sdk, nodes: [node], freshFor: 0, sponsor: sponsorURL, hash });
  await monikerAs.claim("grace", { show: true }, as(mod));
  const picture = png(64, 64);
  const { cid: photo } = await monikerAs.keepPhoto({ type: "image/png", bytes: picture });
  await monikerAs.setProfile({ name: "Grace Hopper", avatar: photo }, as(mod));
  // A reader with nothing cached, as the widget reads: one batch for the thread's authors.
  const moniker = createMoniker({ sdk, nodes: [node], freshFor: 0 });
  await until("@grace and the card land", async () => (await moniker.profile(mod.address))?.avatar === photo && (await moniker.handleOf(mod.address)) === "grace");
  const authors = [mod.address, alice.address, bob.address];
  const [handles, cards] = await Promise.all([moniker.handlesOf(authors), moniker.profiles(authors)]);
  assert.deepEqual(handles, ["grace", undefined, undefined]);
  assert.deepEqual(cards, [{ name: "Grace Hopper", avatar: photo }, undefined, undefined]);
  assert.deepEqual((await moniker.photo(photo)).bytes, picture);
  // Only a verified handle names an author: the card's name and a typed name never do.
  const shown = authors.map((address, i) => authorName({ address, handle: handles[i] }));
  assert.deepEqual(shown, ["@grace", shortAccount(alice.address), shortAccount(bob.address)]);
  console.log(`  admitted on Moniker: the moderator shows @grace, with a ${picture.length}-byte photo kept for work; a reader reads both back`);

  // ------------------------------------------------------------ taking it back
  await page.remove(hello, as(alice));
  await until("the deletion is mined", async () => (await page.comments()).length === 2);
  const after = r.tree(await page.comments());
  assert.equal(after[0].missing, true);
  assert.deepEqual(after[0].replies.map((c) => c.id), [answer]);
  console.log("  admitted: Alice deletes her comment; Bob's reply shows its parent is gone");

  for (const [name, who] of [["Bob", bob], ["The moderator", mod]]) {
    assert.equal(await balance(RIPOSTE, who.address), 0n, `${name} holds coins`);
  }
  assert.equal(await balance(MONIKER, mod.address), 0n, "The moderator holds coins on Moniker");
  assert.equal(await balance(RIPOSTE, alice.address), 5n, "Alice holds only her tip");
  console.log(`Bob and the moderator hold no coins, and Alice only her tip; the sponsor paid every fee, for ${sharesGround} shares of work`);
  console.log("e2e passed");
  if (process.env.E2E_KEEP) await keep(page);
} finally {
  stop();
}
