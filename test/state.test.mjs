// Reading from several hosts (src/state.mjs): a hung host costs one
// wait, then rests while the others answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { anyHost } from "../src/state.mjs";

const hung = { calls: 0, getVolume(cid, signal) { this.calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))); } };
const deaf = { calls: 0, getVolume() { this.calls++; return new Promise(() => {}); } };
const fine = { calls: 0, async getVolume(cid) { this.calls++; return { cid }; } };

test("anyHost: a host past its time limit is passed over for the next reads", async () => {
  const host = anyHost([hung, fine], { timeout: 50, rest: 10_000 });
  const t = Date.now();
  for (let i = 0; i < 6; i++) assert.deepEqual(await host.getVolume(`c${i}`), { cid: `c${i}` });
  assert.equal(hung.calls, 1);
  assert.equal(fine.calls, 6);
  assert.ok(Date.now() - t < 1000, `took ${Date.now() - t} ms`);
});

test("anyHost: the caller's own abort still stops a read", async () => {
  const host = anyHost([hung], { timeout: 10_000 });
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("stopped")), 20);
  await assert.rejects(host.getVolume("c", stop.signal), /stopped/);
});

test("anyHost: a host that ignores the signal is still given up on", async () => {
  const host = anyHost([deaf, fine], { timeout: 50 });
  assert.deepEqual(await host.getVolume("c"), { cid: "c" });
});

test("anyHost: a slow first host is hedged by the next, and every host failing is an error", async () => {
  const slow = { getVolume: () => new Promise((resolve) => setTimeout(() => resolve({ cid: "slow" }), 400)) };
  const quick = { getVolume: async (cid) => ({ cid }) };
  const host = anyHost([slow, quick], { hedge: 20, timeout: 5_000 });
  const t = Date.now();
  assert.deepEqual(await host.getVolume("c"), { cid: "c" });
  assert.ok(Date.now() - t < 200);
  const broken = { getVolume: async () => { throw new Error("down"); } };
  await assert.rejects(anyHost([broken, broken]).getVolume("c"), /down/);
  assert.equal(await anyHost([{ getVolume: async () => null }]).getVolume("c"), null);
});
