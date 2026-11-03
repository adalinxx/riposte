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
