// Reads the chain's general state the way any client can: from a state root,
// by descending the radix trie one content-addressed node at a time. Every
// node is verified against its CID by the loader, so the answer does not
// depend on trusting the node that served it.
//
// Trie shape (cashew's Merkle dictionary):
//   root  { count, children: [{ key, value: { rawCID } }] }
//   node  { prefix, value?, children: [...] }
// A child is filed under the first character of its prefix; a stored key is
// the concatenation of the prefixes on its path.

/**
 * A loader over the SDK's VolumeClient. A node met inside a Volume already
 * fetched is read from it; anything else is one fetch. Nodes are immutable,
 * so they are kept for the life of the loader.
 */
export function volumeLoader(volumes, decodeDagCbor) {
  const nodes = new Map();
  return (cid, within) => {
    if (!nodes.has(cid)) {
      nodes.set(
        cid,
        (async () => {
          const volume = within?.bytes(cid) ? within : await volumes.get(cid);
          return { node: decodeDagCbor(volume.bytes(cid)), volume };
        })(),
      );
    }
    return nodes.get(cid);
  };
}

/**
 * One transport over many hosts. Content is addressed by CID, so whoever
 * holds it may serve it: each read starts at the next host and moves on from
 * one that lacks the content, refuses, or serves bytes that fail their CID.
 */
export function anyHost(transports, { timeout = 10_000, rest = 60_000, hedge = 1_500 } = {}) {
  // Each read asks one host; if it hasn't answered in `hedge` ms the next is
  // asked too, and the first answer wins. A host that fails or keeps a read
  // past `timeout` rests for `rest` ms, asked only after the others.
  const restingUntil = transports.map(() => 0);
  let next = 0;
  const ask = (i, rootCID, signal) => {
    const limit = AbortSignal.timeout(timeout);
    const both = signal ? AbortSignal.any([signal, limit]) : limit;
    // Raced as well as passed on, for a transport that doesn't heed the signal.
    const stopped = new Promise((_, reject) => both.addEventListener("abort", () => reject(both.reason), { once: true }));
    return Promise.race([transports[i].getVolume(rootCID, both), stopped]).then(
      (volume) => volume,
      (error) => {
        if (!signal?.aborted) restingUntil[i] = Date.now() + rest;
        throw error;
      },
    );
  };
  return {
    getVolume(rootCID, signal) {
      const start = next++;
      const now = Date.now();
      const order = transports.map((_, i) => (start + i) % transports.length).sort((a, b) => (restingUntil[a] > now) - (restingUntil[b] > now));
      return new Promise((resolve, reject) => {
        let pending = 0;
        let asked = 0;
        let done = false;
        let failure;
        let timer;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          fn(value);
        };
        const launch = () => {
          if (done || asked >= order.length) return;
          const i = order[asked++];
          pending++;
          ask(i, rootCID, signal).then(
            (volume) => {
              pending--;
              if (volume) return finish(resolve, volume);
              if (!pending && asked >= order.length) finish(resolve, null);
              else launch();
            },
            (error) => {
              pending--;
              failure = error;
              if (signal?.aborted) return finish(reject, error);
              if (asked < order.length) launch();
              else if (!pending) finish(reject, failure);
            },
          );
          clearTimeout(timer);
          if (asked < order.length) timer = setTimeout(launch, hedge);
        };
        launch();
      });
    },
  };
}

function childFor(node, rest) {
  const first = String.fromCodePoint(rest.codePointAt(0));
  return node.children.find((child) => child.key === first)?.value.rawCID;
}

/** The value stored under `key`, or undefined. */
export async function get(load, rootCID, key) {
  let { node, volume } = await load(rootCID);
  let rest = key;
  while (rest.length > 0) {
    const cid = childFor(node, rest);
    if (cid === undefined) return undefined;
    ({ node, volume } = await load(cid, volume));
    if (!rest.startsWith(node.prefix)) return undefined;
    rest = rest.slice(node.prefix.length);
  }
  return node.value;
}

/** Every `[key, value]` whose key starts with `prefix`, in key order. */
export async function* list(load, rootCID, prefix = "") {
  let { node, volume } = await load(rootCID);
  let path = "";
  let rest = prefix;
  while (rest.length > 0) {
    const cid = childFor(node, rest);
    if (cid === undefined) return;
    ({ node, volume } = await load(cid, volume));
    if (rest.startsWith(node.prefix)) rest = rest.slice(node.prefix.length);
    else if (node.prefix.startsWith(rest)) rest = "";
    else return;
    path += node.prefix;
  }
  yield* entries(load, node, volume, path);
}

async function* entries(load, node, volume, path) {
  if (node.value !== undefined) yield [path, node.value];
  const children = [...node.children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Siblings are independent, so fetch them together and yield in order.
  const loaded = children.map((child) => load(child.value.rawCID, volume));
  for (const pending of loaded) {
    const child = await pending;
    yield* entries(load, child.node, child.volume, path + child.node.prefix);
  }
}

/**
 * A node's current tip: the latest block's hash, the general-state root
 * inside its post state, and the CID of the chain spec it runs under. Only
 * the hash is the node's word; the rest is read from the block by CID.
 */
export async function tip(sdk, nodeURL, chainPath, volumes, { timeout = 8_000 } = {}) {
  const url = new URL("/api/block/latest", nodeURL);
  url.searchParams.set("chainPath", chainPath.join("/"));
  // The node lets the latest block be cached for a few seconds; a writer
  // needs the tip as it is now.
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`latest block: HTTP ${response.status}`);
  const { hash } = await response.json();
  const block = sdk.decodeCanonicalBlock((await volumes.get(hash)).rootBytes());
  const state = sdk.decodeCanonicalLatticeState((await volumes.get(block.postStateCID)).rootBytes());
  return { hash, generalStateCID: state.generalStateCID, specCID: block.specCID };
}

/** The state at one root as `{ get(key), list(prefix) }`, which the follow reads take. */
export const view = (load, rootCID) => ({
  get: (key) => get(load, rootCID, key),
  list: (prefix) => list(load, rootCID, prefix),
});

/** The chain spec at `specCID`, as stored: `{ wasmPolicies, premine, … }`. */
export async function chainSpec(sdk, volumes, specCID) {
  return sdk.decodeDagCbor((await volumes.get(specCID)).rootBytes());
}
