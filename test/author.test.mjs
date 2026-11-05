// How the widget names a comment's author (widget/author.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { shortAccount } from "../src/account.mjs";
import { authorName } from "../widget/author.mjs";

const address = "bafyreihpcfcqbxecznct6ryuqfo3xbn6sakrwfos55empvx7gxec75ywyu";
const short = shortAccount(address);

test("a verified handle first, over the card's name and the comment's", () => {
  assert.deepEqual(authorName({ address, handle: "grace", card: { name: "Grace Hopper" }, name: "G" }), { text: "@grace" });
});

test("else the card's name, with the short account ID beside it", () => {
  assert.deepEqual(authorName({ address, card: { name: "Live Trial", avatar: address }, name: "G" }), { text: "Live Trial", id: short });
});

test("else the name given with the comment, else the short account ID", () => {
  assert.deepEqual(authorName({ address, card: { description: "no name" }, name: "Ada" }), { text: "Ada" });
  assert.deepEqual(authorName({ address, name: "Ada" }), { text: "Ada" });
  assert.deepEqual(authorName({ address }), { text: short });
  assert.deepEqual(authorName({ address, name: "  " }), { text: short });
});

test("only a verified handle shows with an @", () => {
  assert.deepEqual(authorName({ address, card: { name: "@grace" } }), { text: "grace", id: short });
  assert.deepEqual(authorName({ address, name: "＠grace" }), { text: "grace" });
  assert.deepEqual(authorName({ address, name: "@" }), { text: short });
  // Invisible and bidi controls are dropped too.
  assert.deepEqual(authorName({ address, name: "Ada‮​" }), { text: "Ada" });
});

test("names are plain text, for the widget to escape", () => {
  assert.deepEqual(authorName({ address, card: { name: "<b>x</b>" } }), { text: "<b>x</b>", id: short });
});
