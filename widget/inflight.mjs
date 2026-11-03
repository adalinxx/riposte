// The reader's write in flight, and what became of it.
//
// A host pools only a write that executes on its tip, so an account has at
// most one waiting at a time: a second, signed past the first, is refused
// ("nonceAhead"). A pooled write the tip stops admitting leaves the pool, and
// resending it is up to its sender. So the widget sends one write at a time
// and watches it. It has landed once the account's nonce passes it. It is
// still waiting while the host it went to still pools it. Otherwise it was
// dropped.

/** How long after sending a write isn't judged dropped: the pool and the tip move apart for a moment. */
export const GRACE = 20_000;

/**
 * `sent` = `{ cid, nonce, host, account, chain, at }`, as Selfhold reported it
 * (`chain` a path string). Resolves "landed", "waiting" or "dropped". A host
 * that doesn't answer leaves it "waiting".
 */
export async function fate(sent, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  const get = async (path) => {
    const response = await fetch(`${sent.host.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}chainPath=${encodeURIComponent(sent.chain)}`, { cache: "no-store" });
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };
  const passed = async () => BigInt((await get(`/api/state/account/${sent.account}`)).nonce ?? 0) > BigInt(sent.nonce);
  try {
    if (await passed()) return "landed";
    if (now - sent.at < GRACE) return "waiting";
    const pool = await get("/api/mempool");
    if ((pool.transactions ?? []).includes(sent.cid)) return "waiting";
    // It may have landed between the two reads.
    return (await passed()) ? "landed" : "dropped";
  } catch {
    return "waiting";
  }
}
