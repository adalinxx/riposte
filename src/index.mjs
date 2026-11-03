// Riposte for any page: comments on a Lattice chain, read from any host and
// checked by CID, written through the person's wallet.
//
//   const riposte = createRiposte({ sdk });                 // sdk: the Lattice SDK module
//   const page = await riposte.page(location.href);         // or riposte.page({ name: "my-post" })
//   await page.comments();                                  // oldest first, with likes
//   await page.comment({ text: "hello" }, { wallet, account });
//
// Writes carry no fee: the wallet sets it, and Selfhold's window pays it in
// this device's work through a fee sponsor, so nobody needs coins to comment.
import * as records from "./records.mjs";
import { anyHost, tip, view, volumeLoader } from "./state.mjs";
import { writeRequest } from "./wallet.mjs";

/** Where Riposte lives now: its testnet trial chain on the shared app hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "riposte"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

export function createRiposte(options) {
  const { sdk, chain, nodes, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createRiposte needs { sdk }: the Lattice SDK module");
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      try {
        const { generalStateCID } = await Promise.any(nodes.map((node) => tip(sdk, node, chain, volumes)));
        return view(load, generalStateCID);
      } catch (error) {
        throw new Error(`No node is serving ${chain.join("/")}`, { cause: error.errors?.[0] ?? error });
      }
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  /**
   * Sends `write` through `wallet` as `account`, unless there is nothing to
   * write: the wallet's answer, or null. `progress` hears the wallet's steps.
   */
  async function send(write, { wallet, account, progress }) {
    if (!wallet?.writeRecords) throw new Error("This needs a Lattice wallet such as Selfhold.");
    if (write.actions.length === 0) return null;
    const sent = await wallet.writeRecords(writeRequest(chain, write), { account, progress });
    current = null;
    return sent;
  }
  const signer = async ({ wallet, account }) => account ?? (await wallet.address?.()) ?? (await wallet.connect());

  /**
   * One page's comments. `which` is the page's address (named by host and
   * path, see records.pageName) or `{ name }`, any string a site chooses, so
   * its comments outlive a move.
   */
  async function page(which) {
    const key = await records.pageKey(typeof which === "string" ? records.pageName(which) : which.name);
    return {
      key,
      /** Every comment, oldest first, each `{ author, id, at, text, name?, reply?, likes }`. */
      comments: async (options) => records.comments(await state(options), key),
      /** What `moderators` hide here: `{ comments: Set<"author/id">, accounts: Set }`. */
      hidden: async (moderators, options) => records.hidden(await state(options), key, moderators),

      /** Comments `{ text, name?, reply?, id? }` as the wallet's account: `{ id, sent }`. */
      comment: async (draft, how) => {
        const write = records.comment(key, await signer(how), draft, draft.id ? { id: draft.id } : undefined);
        return { id: write.id, sent: await send(write, how) };
      },
      remove: async (id, how) => send(await records.remove(await state({ fresh: true }), key, await signer(how), id), how),
      like: async (to, how, on = true) => send(await records.like(await state({ fresh: true }), key, await signer(how), to, on), how),
      hide: async (to, how, on = true) => send(await records.hide(await state({ fresh: true }), key, await signer(how), to, on), how),
      block: async (account, how, on = true) => send(await records.block(await state({ fresh: true }), await signer(how), account, on), how),
    };
  }

  return { chain, nodes, state, page };
}

export * as records from "./records.mjs";
