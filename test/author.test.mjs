// How the widget names a comment's author (widget/author.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortAccount } from "../src/account.mjs";
import { authorName, authorURL } from "../widget/author.mjs";

const address = "bafyreihpcfcqbxecznct6ryuqfo3xbn6sakrwfos55empvx7gxec75ywyu";
const short = shortAccount(address);

test("a verified handle, else the short account ID; never a typed name", () => {
  assert.equal(authorName({ address, handle: "grace" }), "@grace");
  assert.equal(authorName({ address }), short);
  assert.equal(authorName({ address, card: { name: "Grace Hopper" }, name: "Grace" }), short);
});

test("the author links to their Moniker page: the handle's, else the account's", () => {
  assert.equal(authorURL({ address, handle: "grace" }), "https://app.moniker.bio/#/@grace");
  assert.equal(authorURL({ address }), `https://app.moniker.bio/#/account/${address}`);
});
