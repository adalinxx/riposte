// Runs the built policy module the way the Lattice host does (host.mjs), on
// hand-made writes. Bodies are encoded by the Lattice SDK, whose encoding is
// pinned to Lattice's vectors.
//
//   npm run build:policy && node --test test/
//
// With CONTEXT_DIR set, every context is recorded with its verdict so
// policy/host-check can replay it through Lattice's own evaluator.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as sdk from "../vendor/lattice-sdk.js";
import { context, validate } from "./host.mjs";

const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const [ALICE, BOB, MOD] = [address(1), address(2), address(3)];
const PATH = ["Nexus", "riposte"];

const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function accepts(actions, { signers = [ALICE], accountActions = [] } = {}) {
  const body = sdk.encodeTransactionBody({
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 0n,
    chainPath: PATH,
  }).bytes;
  const bytes = context(body, { path: PATH });
  const accepted = validate(bytes);
  if (contextDirectory) writeFileSync(`${contextDirectory}/${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`, bytes);
  return accepted;
}

const PAGE = "k2b7xq4mz5a3d6f7g2h3j4k5l6m7n2pq";
const ID = "lz3k9q2a0x7c1";
const comment = (a, id = ID, page = PAGE) => `comment/${page}/${a}/${id}`;
const text = (t) => JSON.stringify({ text: t });

test("an account comments, and deletes its comment", () => {
  assert.ok(accepts([{ key: comment(ALICE), newValue: text("hello") }]));
  assert.ok(accepts([{ key: comment(ALICE), oldValue: text("hello") }]));
  assert.ok(accepts([{ key: comment(ALICE, "a", "p"), newValue: text("1") }, { key: comment(ALICE, "z".repeat(16), "9".repeat(64)), newValue: text("2") }]));
});

test("a comment is never edited, never empty, never over 10240 bytes", () => {
  assert.ok(!accepts([{ key: comment(ALICE), oldValue: text("hello"), newValue: text("goodbye") }]));
  assert.ok(!accepts([{ key: comment(ALICE), newValue: "" }]));
  assert.ok(accepts([{ key: comment(ALICE), newValue: "x".repeat(10240) }]));
  assert.ok(!accepts([{ key: comment(ALICE), newValue: "x".repeat(10241) }]));
});

test("only its writer writes or deletes a comment", () => {
  assert.ok(!accepts([{ key: comment(ALICE), newValue: text("forged") }], { signers: [BOB] }));
  assert.ok(!accepts([{ key: comment(ALICE), oldValue: text("hello") }], { signers: [BOB] }));
  assert.ok(!accepts([{ key: comment(ALICE), oldValue: text("hello") }], { signers: [MOD] }));
  // Two signers, each writing their own.
  assert.ok(accepts([{ key: comment(ALICE), newValue: text("a") }, { key: comment(BOB), newValue: text("b") }], { signers: [ALICE, BOB] }));
});

test("keys are spelled one way", () => {
  for (const key of [
    `comment/${PAGE}/${ALICE}`,
    `comment/${PAGE}/${ALICE}/${ID}/x`,
    `comment/${PAGE.toUpperCase()}/${ALICE}/${ID}`,
    `comment/${"a".repeat(65)}/${ALICE}/${ID}`,
    `comment//${ALICE}/${ID}`,
    `comment/${PAGE}/${ALICE}/${"a".repeat(17)}`,
    `comment/${PAGE}/${ALICE}/a-b`,
    `comment/${PAGE}/${ALICE.toUpperCase()}/${ID}`,
    `profile/${ALICE}`,
    `post/${ALICE}/${ID}`,
  ]) assert.ok(!accepts([{ key, newValue: text("x") }]), key);
});

test("likes: the liker's own, value 1", () => {
  const like = `like/${PAGE}/${BOB}/${ID}/${ALICE}`;
  assert.ok(accepts([{ key: like, newValue: "1" }]));
  assert.ok(accepts([{ key: like, oldValue: "1" }]));
  assert.ok(!accepts([{ key: like, newValue: "2" }]));
  assert.ok(!accepts([{ key: like, newValue: "1" }], { signers: [BOB] }));
  assert.ok(!accepts([{ key: `like/${PAGE}/${BOB}/${ID}`, newValue: "1" }]));
});

test("moderators mark, and only their own marks", () => {
  const hide = `hide/${MOD}/${PAGE}/${ALICE}/${ID}`;
  const block = `block/${MOD}/${ALICE}`;
  assert.ok(accepts([{ key: hide, newValue: "1" }, { key: block, newValue: "1" }], { signers: [MOD] }));
  assert.ok(accepts([{ key: hide, oldValue: "1" }, { key: block, oldValue: "1" }], { signers: [MOD] }));
  assert.ok(!accepts([{ key: hide, newValue: "1" }], { signers: [ALICE] }));
  assert.ok(!accepts([{ key: block, newValue: "1" }], { signers: [ALICE] }));
  assert.ok(!accepts([{ key: hide, newValue: "yes" }], { signers: [MOD] }));
  assert.ok(!accepts([{ key: `block/${MOD}/${ALICE}/x`, newValue: "1" }], { signers: [MOD] }));
  assert.ok(!accepts([{ key: `block/${MOD}/nobody`, newValue: "1" }], { signers: [MOD] }));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 5n }] }));
  assert.ok(accepts([{ key: comment(ALICE), newValue: text("paid") }], { accountActions: [{ owner: ALICE, delta: -1n }] }));
});

// ---------------------------------------------------------------- tips

const tip = (a, author = BOB, tid = "lz3k9q2a1abcd", id = ID) => `tip/${PAGE}/${author}/${id}/${a}/${tid}`;
/** What a wallet writes for a tip: the tipper's debit, then the author's credit. */
const paid = (from, to, amount) => [{ owner: from, delta: -BigInt(amount) }, { owner: to, delta: BigInt(amount) }];

test("a tip: created by the tipper, with the author credited at least the amount", () => {
  assert.ok(accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: paid(ALICE, BOB, 5) }));
  // More than the amount is fine; the tip records what was promised.
  assert.ok(accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: paid(ALICE, BOB, 7) }));
  // Paid by work: the sponsor credits the tipper, who nets to nothing; the author is still credited.
  assert.ok(accepts([{ key: tip(ALICE), newValue: "5" }], {
    signers: [ALICE, MOD],
    accountActions: [...paid(ALICE, BOB, 5), { owner: ALICE, delta: 5n }, { owner: MOD, delta: -6n }],
  }));
});

test("a tip the author isn't credited for is refused", () => {
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }]));
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: paid(ALICE, BOB, 4) }));
  // Credited someone else.
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: paid(ALICE, MOD, 5) }));
  // Two credits that add up don't pay one tip: one credit pays one run of tips.
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 2n }, { owner: BOB, delta: 3n }] }));
  // A debit of the author comes first: not a credit.
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { accountActions: [{ owner: BOB, delta: -1n }, { owner: BOB, delta: 5n }, { owner: ALICE, delta: -4n }] }));
});

test("a self-tip, or a tip its author signs, is refused", () => {
  assert.ok(!accepts([{ key: tip(ALICE, ALICE), newValue: "5" }], { accountActions: [{ owner: ALICE, delta: -5n }, { owner: ALICE, delta: 5n }] }));
  // The author signing could take the credit straight back.
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { signers: [ALICE, BOB], accountActions: [...paid(ALICE, BOB, 5), { owner: BOB, delta: -5n }, { owner: ALICE, delta: 5n }] }));
});

test("a tip is never edited or deleted", () => {
  assert.ok(!accepts([{ key: tip(ALICE), oldValue: "5", newValue: "50" }], { accountActions: paid(ALICE, BOB, 50) }));
  assert.ok(!accepts([{ key: tip(ALICE), oldValue: "5" }]));
  assert.ok(!accepts([{ key: tip(ALICE), oldValue: "5" }], { accountActions: paid(ALICE, BOB, 5) }));
});

test("a tip's amount is a canonical decimal of at least 1", () => {
  for (const amount of ["0", "05", "", "-5", "5.0", "1e3", " 5", "+5", "18446744073709551616", "five"]) {
    assert.ok(!accepts([{ key: tip(ALICE), newValue: amount }], { accountActions: paid(ALICE, BOB, 5) }), JSON.stringify(amount));
  }
  assert.ok(accepts([{ key: tip(ALICE), newValue: "1" }], { accountActions: paid(ALICE, BOB, 1) }));
});

test("only the tipper signs a tip, and its key is spelled one way", () => {
  assert.ok(!accepts([{ key: tip(ALICE), newValue: "5" }], { signers: [MOD], accountActions: paid(MOD, BOB, 5) }));
  for (const key of [
    `tip/${PAGE}/${BOB}/${ID}/${ALICE}`,
    `tip/${PAGE}/${BOB}/${ID}/${ALICE}/x/y`,
    `tip/${PAGE}/${BOB}/${ID}/${ALICE}/A`,
    `tip/${PAGE}/${BOB}/${ID}/${ALICE}/${"a".repeat(17)}`,
    `tip/${PAGE}/nobody/${ID}/${ALICE}/x`,
    `tip/${PAGE.toUpperCase()}/${BOB}/${ID}/${ALICE}/x`,
  ]) assert.ok(!accepts([{ key, newValue: "5" }], { accountActions: paid(ALICE, BOB, 5) }), key);
});

test("several tips in one write: each run of tips to an author is paid by one credit, in order", () => {
  const two = [{ key: tip(ALICE, BOB, "a"), newValue: "2" }, { key: tip(ALICE, BOB, "b"), newValue: "3" }];
  assert.ok(accepts(two, { accountActions: paid(ALICE, BOB, 5) }));
  assert.ok(!accepts(two, { accountActions: paid(ALICE, BOB, 4) }));
  // To two authors: credited in the order their tips come.
  const both = [{ key: tip(ALICE, BOB, "a"), newValue: "2" }, { key: tip(ALICE, MOD, "b"), newValue: "3" }];
  const credits = [{ owner: ALICE, delta: -5n }, { owner: BOB, delta: 2n }, { owner: MOD, delta: 3n }];
  assert.ok(accepts(both, { accountActions: credits }));
  assert.ok(!accepts(both, { accountActions: [credits[0], credits[2], credits[1]] }));
  // Tips to one author that aren't together are two runs, and need two credits.
  const apart = [{ key: tip(ALICE, BOB, "a"), newValue: "2" }, { key: tip(ALICE, MOD, "b"), newValue: "3" }, { key: tip(ALICE, BOB, "c"), newValue: "4" }];
  assert.ok(!accepts(apart, { accountActions: [{ owner: ALICE, delta: -9n }, { owner: BOB, delta: 6n }, { owner: MOD, delta: 3n }] }));
  assert.ok(accepts(apart, { accountActions: [{ owner: ALICE, delta: -9n }, { owner: BOB, delta: 2n }, { owner: MOD, delta: 3n }, { owner: BOB, delta: 4n }] }));
});

test("a tip beside comments and likes", () => {
  assert.ok(accepts([
    { key: comment(ALICE), newValue: text("thanks for this") },
    { key: tip(ALICE), newValue: "1" },
    { key: `like/${PAGE}/${BOB}/${ID}/${ALICE}`, newValue: "1" },
  ], { accountActions: paid(ALICE, BOB, 1) }));
});
