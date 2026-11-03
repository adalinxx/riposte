// The records over an in-memory state, applying writes as the chain would.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as r from "../src/records.mjs";

const A = "bafyreia" + "a".repeat(50) + "a";
const B = "bafyreib" + "b".repeat(50) + "a";
const M = "bafyreic" + "c".repeat(50) + "a";

function memory() {
  const map = new Map();
  return {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
    apply({ actions }) {
      for (const { key, oldValue, newValue } of actions) {
        assert.equal(map.get(key), oldValue, `${key}: old value`);
        if (newValue === undefined) map.delete(key);
        else map.set(key, newValue);
      }
    },
  };
}

test("addresses as the policy spells them", () => {
  assert.ok(r.isAddress(A));
  assert.ok(!r.isAddress(A.toUpperCase()));
  assert.ok(!r.isAddress(A.slice(0, -1)));
});

test("a page's name drops what doesn't name it", () => {
  const same = ["https://www.example.com/posts/hello/", "http://example.com/posts/hello", "https://example.com/posts/hello/index.html?utm=x#comments", "https://EXAMPLE.com/posts/hello//"];
  for (const href of same) assert.equal(r.pageName(href), "example.com/posts/hello", href);
  assert.equal(r.pageName("https://example.com/"), "example.com/");
  assert.equal(r.pageName("https://example.com/index.html"), "example.com/");
  assert.equal(r.pageName("http://localhost:4000/a/"), "localhost:4000/a");
  assert.notEqual(r.pageName("https://example.com/Posts"), r.pageName("https://example.com/posts"));
});

test("a page's key is 32 base-32 characters, fixed by its name", async () => {
  const key = await r.pageKey("example.com/posts/hello");
  assert.match(key, /^[a-z2-7]{32}$/);
  assert.ok(r.isPage(key));
  assert.equal(key, await r.pageKey("example.com/posts/hello"));
  assert.notEqual(key, await r.pageKey("example.com/posts/hello2"));
  // Known answer: SHA-256("abc") = ba7816bf…, in base 32 "xj4bnp4p…".
  assert.equal(await r.pageKey("abc"), "xj4bnp4pahh6uqkbidpf3lrceoyagynd");
  await assert.rejects(r.pageKey(" "));
});

test("ids sort by time and say when", () => {
  const a = r.newId(1_700_000_000_000), b = r.newId(1_700_000_000_001);
  assert.ok(a < b);
  assert.equal(r.timeOf(a), 1_700_000_000_000);
  assert.ok(r.isId(a));
  assert.equal(r.timeOf("x"), undefined);
});

test("comments, replies and likes read back as a tree", async () => {
  const s = memory();
  const page = await r.pageKey("example.com/p");
  const first = r.comment(page, A, { text: "  First!  ", name: " Ada " }, { id: r.newId(1000) });
  s.apply(first);
  const answer = r.comment(page, B, { text: "Hi Ada", reply: { author: A, id: first.id } }, { id: r.newId(2000) });
  s.apply(answer);
  const other = r.comment(page, B, { text: "Another thought" }, { id: r.newId(3000) });
  s.apply(other);
  s.apply(await r.like(s, page, B, { author: A, id: first.id }));
  s.apply(await r.like(s, page, A, { author: A, id: first.id }));
  assert.deepEqual((await r.like(s, page, A, { author: A, id: first.id })).actions, [], "liking twice writes nothing");

  const list = await r.comments(s, page);
  assert.deepEqual(list.map((c) => c.text), ["First!", "Hi Ada", "Another thought"]);
  assert.equal(list[0].name, "Ada");
  assert.equal(list[0].at, 1000);
  assert.deepEqual(new Set(list[0].likes), new Set([A, B]));
  const t = r.tree(list);
  assert.deepEqual(t.map((c) => c.text), ["First!", "Another thought"]);
  assert.deepEqual(t[0].replies.map((c) => c.text), ["Hi Ada"]);

  // Another page sees none of it.
  assert.deepEqual(await r.comments(s, await r.pageKey("example.com/q")), []);

  // Unlike; delete the first: its reply hangs under a stand-in.
  s.apply(await r.like(s, page, B, { author: A, id: first.id }, false));
  s.apply(await r.remove(s, page, A, first.id));
  assert.deepEqual((await r.remove(s, page, A, first.id)).actions, []);
  const after = r.tree(await r.comments(s, page));
  assert.equal(after[0].missing, true);
  assert.deepEqual(after[0].replies.map((c) => c.text), ["Hi Ada"]);
  assert.deepEqual(after.map((c) => c.text ?? "(gone)"), ["(gone)", "Another thought"]);
});

test("moderators' marks", async () => {
  const s = memory();
  const page = await r.pageKey("example.com/p");
  const c = r.comment(page, A, { text: "spam" });
  s.apply(c);
  s.apply(await r.hide(s, page, M, { author: A, id: c.id }));
  s.apply(await r.block(s, M, B));
  const marks = await r.hidden(s, page, [M, "not an address"]);
  assert.deepEqual([...marks.comments], [`${A}/${c.id}`]);
  assert.deepEqual([...marks.accounts], [B]);
  // Someone else's marks hide nothing here.
  const none = await r.hidden(s, page, [A]);
  assert.equal(none.comments.size + none.accounts.size, 0);
  s.apply(await r.hide(s, page, M, { author: A, id: c.id }, false));
  assert.equal((await r.hidden(s, page, [M])).comments.size, 0);
});

test("what isn't a comment is left out, and bad drafts are refused", async () => {
  for (const value of ["", "x", "[]", "null", '{"text":""}', '{"text":"  "}', '{"text":5}', `{"text":"x","reply":{"author":"nope","id":"a"}}`, JSON.stringify({ text: "x".repeat(2001) })]) {
    assert.equal(r.parseComment(value), undefined, value);
  }
  assert.deepEqual(r.parseComment(JSON.stringify({ text: "ok", name: "n".repeat(60), extra: 1 })), { text: "ok", name: "n".repeat(40) });
  const page = await r.pageKey("x");
  assert.throws(() => r.comment(page, A, { text: " " }), /Write something/);
  assert.throws(() => r.comment(page, A, { text: "x".repeat(2001) }), /at most 2000/);
  assert.throws(() => r.comment(page, A, { text: "x", name: "n".repeat(41) }), /name/);
  assert.throws(() => r.comment("Bad Page", A, { text: "x" }), /page/);
  // The longest comment fits the policy's limit.
  const big = r.comment(page, A, { text: "😀".repeat(2000), name: "😀".repeat(40), reply: { author: B, id: r.newId() } });
  assert.ok(new TextEncoder().encode(big.actions[0].newValue).length <= r.MAX_VALUE);
});

test("a reply cycle still shows", () => {
  const x = { author: A, id: "a1", text: "x", reply: { author: B, id: "b1" }, likes: [] };
  const y = { author: B, id: "b1", text: "y", reply: { author: A, id: "a1" }, likes: [] };
  const t = r.tree([x, y]);
  const all = [];
  const walk = (ns) => ns.forEach((n) => (all.push(n.text), walk(n.replies)));
  walk(t);
  assert.deepEqual(all.sort(), ["x", "y"]);
});
