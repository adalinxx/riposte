// What became of a write (widget/inflight.mjs), against a stand-in host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRACE, fate } from "../widget/inflight.mjs";

const sent = { cid: "bafyreitx", nonce: "4", host: "https://host.example/", account: "bafyreiacct", chain: "Nexus/testnet/riposte", at: 1_000_000 };
/** A host whose account nonce and pool read in turn from `nonces` and `pool`. */
function host({ nonces, pool = [], down = false }) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    if (down) throw new Error("offline");
    const u = new URL(url);
    if (u.pathname.startsWith("/api/state/account/")) return Response.json({ nonce: String(nonces.shift() ?? nonces.at(-1)) });
    if (u.pathname === "/api/mempool") return Response.json({ count: pool.length, transactions: pool });
    return new Response("", { status: 404 });
  };
  return { fetch, asked };
}

test("landed once the account's nonce passes the write's", async () => {
  assert.equal(await fate(sent, { ...host({ nonces: [5] }), now: sent.at + 1 }), "landed");
  assert.equal(await fate(sent, { ...host({ nonces: [4] }), now: sent.at + 1 }), "waiting");
});

test("waiting while the host still pools it, dropped once it doesn't", async () => {
  const later = sent.at + GRACE + 1;
  assert.equal(await fate(sent, { ...host({ nonces: [4], pool: ["other", "bafyreitx"] }), now: later }), "waiting");
  assert.equal(await fate(sent, { ...host({ nonces: [4, 4], pool: ["other"] }), now: later }), "dropped");
  // It left the pool because it landed in between: landed, not dropped.
  assert.equal(await fate(sent, { ...host({ nonces: [4, 5], pool: [] }), now: later }), "landed");
});

test("never dropped inside the grace period, or while the host can't be read", async () => {
  assert.equal(await fate(sent, { ...host({ nonces: [4], pool: [] }), now: sent.at + GRACE - 1 }), "waiting");
  assert.equal(await fate(sent, { ...host({ nonces: [4], down: true }), now: sent.at + GRACE + 1 }), "waiting");
});

test("reads the chain it was sent on, fresh", async () => {
  const h = host({ nonces: [4, 4], pool: [] });
  await fate(sent, { ...h, now: sent.at + GRACE + 1 });
  assert.ok(h.asked.every((url) => url.startsWith("https://host.example/") && url.includes("chainPath=Nexus%2Ftestnet%2Friposte")), h.asked.join("\n"));
});
