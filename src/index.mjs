// Riposte for any page: comments on a Lattice chain, read from any host and
// checked by CID, written through the person's wallet.
//
//   const riposte = createRiposte({ sdk });                 // sdk: the Lattice SDK module
//   const page = await riposte.page(location.href);         // or riposte.page({ name: "my-post" })
//   await page.comments();                                  // oldest first, with likes and tips
//   await page.comment({ text: "hello" }, { wallet, account });
//   await page.tip({ author, id }, 5, { wallet, account });  // pays the author 5 coins
//
// Writes carry no fee: the wallet sets it, and Selfhold's window pays it in
// this device's work through a fee sponsor, so nobody needs coins to comment.
import * as records from "./records.mjs";
import { anyHost, tip, view, volumeLoader } from "./state.mjs";
import { writeRequest } from "./wallet.mjs";

/** Where Riposte lives now: its testnet trial chain on the shared app hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "riposte-1fab4d"],
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
  async function send(write, { wallet, account, progress }, fund) {
    if (!wallet?.writeRecords) throw new Error("This needs a Lattice wallet such as Selfhold.");
    if (write.actions.length === 0) return null;
    const sent = await wallet.writeRecords(writeRequest(chain, write, fund), { account, progress });
    current = null;
    return sent;
  }
  const signer = async ({ wallet, account }) => account ?? (await wallet.address?.()) ?? (await wallet.connect());

  /** `account`'s coins on the chain, as the first node to answer says: a BigInt, 0 for an account it hasn't seen. */
  async function balance(account) {
    const read = async (node) => {
      const url = new URL(`/api/state/account/${account}`, node);
      url.searchParams.set("chainPath", chain.join("/"));
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (response.status === 404) return 0n;
      if (!response.ok) throw new Error(`account: HTTP ${response.status}`);
      return BigInt((await response.json()).balance ?? 0);
    };
    try {
      return await Promise.any(nodes.map(read));
    } catch (error) {
      throw new Error(`No node is serving ${chain.join("/")}`, { cause: error.errors?.[0] ?? error });
    }
  }

  /**
   * One page's comments. `which` is the page's address (named by host and
   * path, see records.pageName) or `{ name, site? }`, any string a site
   * chooses, so its comments outlive a move within the site; `site` is the
   * host it is on, by default this page's.
   */
  async function page(which) {
    const href = typeof which === "string" ? which : null;
    const site = href ? records.siteName(href) : which.site ?? globalThis.location?.host;
    const key = await records.pageKey(site, href ? records.pageName(href) : which.name);
    // Readers' writes here are all under the site's prefixes, so a fund for the site may pay their fees.
    const fund = records.fundPrefixes(records.siteOf(key));
    return {
      key,
      /** The key of the site the page is on. */
      site: records.siteOf(key),
      /** The key prefixes a fee sponsor's fund for this site pays writes under. */
      fund,
      /** Every comment, oldest first, each `{ author, id, at, text, name?, reply?, likes, tips: { count, total } }`. */
      comments: async (options) => records.comments(await state(options), key),
      /** The accounts `account` muted, for themselves: a Set. Mutes hold on every page. */
      muted: async (account, options) => records.muted(await state(options), account),
      /** What `moderators` hide here: `{ comments: Set<"author/id">, accounts: Set }`. */
      hidden: async (moderators, options) => records.hidden(await state(options), key, moderators),

      /** Comments `{ text, name?, reply?, id? }` as the wallet's account: `{ id, sent }`. */
      comment: async (draft, how) => {
        const write = records.comment(key, await signer(how), draft, draft.id ? { id: draft.id } : undefined);
        return { id: write.id, sent: await send(write, how, fund) };
      },
      /**
       * Tips the comment `to` (`{ author, id }`) `amount` coins from the
       * account's balance, paid to its author in the same write: `{ id, sent }`.
       * Only the fee is paid as for any write. A balance short of `amount`
       * is refused here, before the wallet is asked.
       */
      tip: async (to, amount, how, { id } = {}) => {
        const account = await signer(how);
        const write = records.tip(key, account, to, amount, id ? { id } : undefined);
        const holds = await balance(account);
        if (holds < BigInt(write.payments[0].amount)) throw Object.assign(new Error(`A tip of ${write.payments[0].amount} needs that many coins, and this account holds ${holds}.`), { code: "NotEnoughCoins", balance: holds });
        return { id: write.id, sent: await send(write, how, fund) };
      },
      remove: async (id, how) => send(await records.remove(await state({ fresh: true }), key, await signer(how), id), how, fund),
      like: async (to, how, on = true) => send(await records.like(await state({ fresh: true }), key, await signer(how), to, on), how, fund),
      hide: async (to, how, on = true) => send(await records.hide(await state({ fresh: true }), key, await signer(how), to, on), how),
      /** Mutes (or unmutes) `account` for the signed-in reader alone, on every page. */
      mute: async (account, how, on = true) => send(await records.mute(await state({ fresh: true }), await signer(how), account, on), how),
      block: async (account, how, on = true) => send(await records.block(await state({ fresh: true }), await signer(how), account, on), how),
    };
  }

  return { chain, nodes, state, page, balance };
}

export * as records from "./records.mjs";
