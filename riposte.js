// Riposte: comments for any web page, with no server, no sign-up and no coins.
//
//   <div id="riposte"></div>
//   <script type="module" src="https://riposte.page/riposte.js"></script>
//
// The element may say:
//   data-page        a name for the page on this site that outlives its path (default: its host and path)
//   data-url         show another address's thread, as an embed there would (the discuss page)
//   data-moderators  account IDs, comma-separated, whose hide/block marks this page follows
//   data-chain, data-nodes, data-sponsor, data-wallet   another chain, hosts, fee sponsor or Selfhold
//
// Comments are read from any node serving the chain, checked by CID. A comment
// is written through Selfhold: a passkey signs it, and the device pays its fee
// with a few seconds of work through a fee sponsor, so nobody holds a coin.
// Authors show the @handle and photo they chose on Moniker, read from the same hosts,
// and link to their Moniker page.
import * as sdk from "./vendor/lattice-sdk.js";
import { selfhold } from "./vendor/selfhold.mjs";
import { createRiposte, DEFAULTS } from "./src/index.mjs";
import * as records from "./src/records.mjs";
import { accountIcon } from "./src/account.mjs";
import { TIP_AMOUNTS, ago, count, esc, renderText, tipCheck, tipsLabel } from "./widget/text.mjs";
import { fate } from "./widget/inflight.mjs";
import { authorName, authorURL } from "./widget/author.mjs";
import { createMoniker } from "./vendor/moniker/index.mjs";

const SPONSOR = "https://lattice-testnet-apps-iad.fly.dev:8650/sponsor";
const HOME = new URL("./", import.meta.url).href;
const MONIKER_APP = "https://app.moniker.bio/";
const list = (text) => String(text ?? "").split(/[\s,]+/).filter(Boolean);

const STYLE = `
:host { display: block; color: inherit; font: inherit; line-height: 1.5;
  --line: color-mix(in srgb, currentColor 15%, transparent);
  --soft: color-mix(in srgb, currentColor 5%, transparent);
  --muted: color-mix(in srgb, currentColor 62%, transparent);
  --accent: var(--riposte-accent, var(--found-accent, #2f6fdf));
  --on-accent: var(--riposte-on-accent, var(--found-on-accent, #fff)); }
* { box-sizing: border-box; }
.rp { max-width: 100%; }
button, textarea, input { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
.head h2 { font-size: 1.15em; margin: 0; font-weight: 650; }
.sort { display: flex; gap: 2px; font-size: .85em; }
.sort button { background: none; border: 0; padding: 2px 8px; border-radius: 999px; color: var(--muted); }
.sort button[aria-pressed="true"] { background: var(--soft); color: inherit; font-weight: 600; }
form.compose { border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin-bottom: 20px; background: var(--soft); }
form.compose:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, transparent); }
textarea { display: block; width: 100%; min-height: 4.5em; resize: vertical; border: 0; background: transparent; padding: 4px; outline: none; }
.compose .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.compose .who { flex: 1 1 auto; display: flex; align-items: center; gap: 6px; font-size: .9em; color: var(--muted); min-width: 0; }
.compose .who b { color: inherit; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link { background: none; border: 0; padding: 0; color: var(--muted); text-decoration: underline; font-size: inherit; }
button.post { margin-left: auto; background: var(--accent); color: var(--on-accent); border: 0; border-radius: 8px; padding: 6px 16px; font-weight: 600; }
button.post[disabled] { opacity: .55; cursor: default; }
button.cancel { background: none; border: 0; color: var(--muted); padding: 6px 8px; }
.note { font-size: .82em; color: var(--muted); margin: 6px 4px 0; }
.status { font-size: .88em; margin: 8px 4px 0; }
.status.bad { color: #c2410c; }
ol { list-style: none; margin: 0; padding: 0; }
ol ol { margin-left: 18px; padding-left: 14px; border-left: 2px solid var(--line); }
li.c { margin: 0 0 14px; }
.c > .body { display: grid; grid-template-columns: 32px 1fr; gap: 0 10px; }
.avatar { width: 32px; height: 32px; border-radius: 50%; overflow: hidden; grid-row: span 3; background: var(--soft); }
.avatar svg, .avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.meta { font-size: .88em; color: var(--muted); display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; }
.meta .name { color: inherit; font-weight: 650; text-decoration: none; }
.meta .name:hover { text-decoration: underline; }
.avatar-link { grid-row: span 3; display: block; }
.avatar-link .avatar { display: block; }
.meta .you { font-size: .85em; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 2px 0 0; }
.acts { display: flex; gap: 14px; font-size: .85em; margin-top: 4px; flex-wrap: wrap; }
.acts button { background: none; border: 0; padding: 0; color: var(--muted); }
.acts button:hover, .link:hover { color: inherit; }
.acts button[aria-pressed="true"] { color: var(--accent); font-weight: 600; }
.acts .tipbadge { color: var(--accent); font-weight: 650; }
li.c.tipped > .body { border-left: 3px solid var(--accent); border-radius: 8px; padding: 6px 8px 6px 7px; margin-left: -10px;
  background: color-mix(in srgb, var(--accent) 7%, transparent); box-shadow: 0 1px 6px color-mix(in srgb, var(--accent) 18%, transparent); }
.tipped-by { font-size: .85em; color: var(--accent); font-weight: 650; }
.tipper { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 2px; font-size: .88em; }
.tipper .amount { border: 1px solid var(--line); background: none; border-radius: 999px; padding: 2px 10px; }
.tipper .amount[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 650; }
.tipper button.post { margin-left: 0; padding: 3px 12px; }
.tipper .note { flex-basis: 100%; margin: 2px 0 0; }
.pending { opacity: .7; }
.pending .meta::after { content: attr(data-state); font-style: italic; }
.gone > .body .text, .hidden-note { color: var(--muted); font-style: italic; }
.hidden-note { font-size: .88em; margin: 0 0 14px; }
.marked { opacity: .5; }
.empty, .loading { color: var(--muted); padding: 8px 0 16px; }
.more { display: block; margin: 0 0 16px; background: none; border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; color: var(--muted); }
.foot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: .8em; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; margin-top: 8px; }
.foot a { color: inherit; }
form.reply { margin: 8px 0 4px; }
`;

const DEPTH = 4; // replies deeper than this sit at this depth
const PAGE_SIZE = 50; // top-level comments shown before "Show more"
const STALE = 20 * 60_000; // a write not read back by then probably didn't go through
const PROFILES_KEPT = 256; // authors' Moniker profiles kept read on a page, as many as Moniker's photos

/** Reads and writes localStorage without failing where it's blocked. */
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

/** What went wrong with a write, for a person. */
function walletMessage(error) {
  if (error?.code === "NotEnoughCoins") return String(error.message);
  // No sponsor asked: the account's own coins fall short, as for a tip (coinOnly), which no work pays.
  if (error?.code === "NeedsCoins" && error.sponsor === null) {
    return `Your account holds ${count(Number(error.balance), "coin")}, and this needs ${error.needed} from your coins. Nothing was sent.`;
  }
  if (error?.code === "NeedsCoins") {
    const why = {
      down: "The fee sponsor isn't answering right now, so this device's work can't pay for the comment.",
      dear: "This device can't do the work in reasonable time right now.",
      most: "The fee sponsor pays only so much for one comment, and this one costs more.",
    }[error.sponsor] ?? "The fee sponsor couldn't pay for this comment.";
    return `${why} Try again in a few minutes.`;
  }
  const text = String(error?.message ?? error);
  if (error?.code === "PopupBlocked") return "Your browser blocked Selfhold's window. Allow pop-ups for this site, then try again.";
  if (error?.code === "Closed") return "Selfhold's window was closed. Nothing was sent.";
  if (/just declined|in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  return text;
}

/** The page's own link colour, so the widget's accent matches the site. */
function siteAccent(element) {
  const probe = document.createElement("a");
  probe.href = "#";
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  element.parentNode.insertBefore(probe, element);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** Black or white, whichever reads better on `color` ("rgb(r, g, b)"). */
function textOn(color) {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? [0, 0, 0]).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast with white is 1.05 / (L + .05); with black (L + .05) / .05.
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? "#fff" : "#111";
}

async function mount(element) {
  if (element.riposte) return;
  element.riposte = true;
  const data = element.dataset;
  const chain = data.chain ? data.chain.split("/") : DEFAULTS.chain;
  const nodes = data.nodes ? list(data.nodes) : DEFAULTS.nodes;
  const sponsor = data.sponsor ?? SPONSOR;
  const moderators = list(data.moderators).filter(records.isAddress);
  const riposte = createRiposte({ sdk, chain, nodes });
  const page = await riposte.page(data.url ? data.url : data.page ? { name: data.page, site: location.host } : location.href);
  const wallet = selfhold({ use: "window", ...(data.wallet && { wallet: data.wallet }), hosts: () => nodes, sponsor: () => sponsor });

  const root = element.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLE}</style><section class="rp" aria-label="Comments"></section>`;
  const accent = siteAccent(element);
  root.host.style.setProperty("--found-accent", accent);
  root.host.style.setProperty("--found-on-accent", textOn(accent));
  const view = root.querySelector(".rp");

  const PENDING = `riposte.pending.${chain.join("/")}.${page.key}`;
  // The account's last write, until it lands: a host takes one at a time.
  const INFLIGHT = `riposte.inflight.${chain.join("/")}`;
  const state = {
    me: await wallet.address().catch(() => null),
    comments: null, // null while loading
    hidden: { comments: new Set(), accounts: new Set() },
    muted: new Set(), // authors this reader muted, for themselves
    tipFor: null, // "author/id" of the open Tip control
    tipAmount: TIP_AMOUNTS[0],
    balance: null, // the reader's coins, read when the Tip control opens
    tipping: new Map(), // "author/id" → the total that shows a sent tip landed
    error: null,
    // Comments sent from here and not yet read back; after STALE they offer Retry.
    pending: store.get(PENDING, []).filter((p) => Date.now() - p.sentAt < 86_400_000),
    likes: new Map(), // "author/id" → true|false while a like is saving
    sort: store.get("riposte.sort", "oldest"),
    shown: PAGE_SIZE,
    replyTo: null, // "author/id" of the open reply box
    reveal: new Set(), // hidden comments the reader chose to see
    inflight: store.get(INFLIGHT, null), // { cid, nonce, host, account, chain, at }
    status: "", // the composer's line
    bad: false,
    busy: false,
  };
  const keyOf = (c) => `${c.author}/${c.id}`;
  const isMod = () => state.me !== null && moderators.includes(state.me);

  async function load() {
    try {
      const me = state.me;
      const [comments, hidden, muted] = await Promise.all([page.comments({ fresh: true }), page.hidden(moderators), me ? page.muted(me) : new Set()]);
      state.comments = comments;
      state.hidden = hidden;
      state.muted = muted;
      state.error = null;
      const landed = new Set(comments.map(keyOf));
      state.pending = state.pending.filter((p) => !landed.has(keyOf(p)));
      store.set(PENDING, state.pending.length ? state.pending : undefined);
      for (const [key, on] of state.likes) {
        const c = comments.find((x) => keyOf(x) === key);
        if (c && c.likes.includes(state.me) === on) state.likes.delete(key);
      }
      for (const [key, total] of state.tipping) if ((comments.find((x) => keyOf(x) === key)?.tips.total ?? 0n) >= total) state.tipping.delete(key);
      lookUp([...comments.map((c) => c.author), ...(me ? [me] : [])]);
    } catch (error) {
      state.error = error;
    }
    render();
  }

  // ------------------------------------------------------------ Moniker

  // Authors' handles, cards and photos, read from Moniker in one batch per
  // thread drawn and kept for the page. The thread never waits for them: it
  // is drawn first, and again as they arrive. Unread, an author shows as before.
  const moniker = createMoniker({ sdk, nodes });
  const profiles = new Map(); // account → { handle?, card?, photo? (an object URL) }, oldest first
  const asking = new Set();
  async function lookUp(accounts) {
    const wanted = [...new Set(accounts)].filter((a) => !profiles.has(a) && !asking.has(a));
    if (!wanted.length) return;
    wanted.forEach((a) => asking.add(a));
    try {
      const [handles, cards] = await Promise.all([moniker.handlesOf(wanted), moniker.profiles(wanted)]);
      const found = wanted.map((account, i) => ({ account, handle: handles[i], card: cards[i] }));
      for (const p of found) {
        profiles.set(p.account, p);
        for (const old of profiles.keys()) if (profiles.size > PROFILES_KEPT) profiles.delete(old);
      }
      render();
      // Each photo is checked by CID, and is a WebP, PNG or JPEG of at most 256 KB, or isn't shown.
      const photos = await Promise.all(found.map(async (p) => p.card?.avatar && (p.photo = await moniker.photoURL(p.card.avatar))));
      if (photos.some(Boolean)) render();
    } catch {
      // Moniker unread: asked again on the next load.
    } finally {
      wanted.forEach((a) => asking.delete(a));
    }
  }

  // ------------------------------------------------------------ drawing

  const avatar = (account) => {
    const photo = profiles.get(account)?.photo;
    return `<span class="avatar" aria-hidden="true">${photo ? `<img src="${esc(photo)}" alt="">` : accountIcon(account, 32)}</span>`;
  };
  // An author is their verified Moniker handle, else their short account ID,
  // and links to their Moniker page. A name anyone can type is never shown.
  const who = (account) => ({ address: account, handle: profiles.get(account)?.handle });
  const nameOf = (c) => `<a class="name" href="${esc(authorURL(who(c.author)))}" target="_blank" rel="noopener" title="${esc(c.author)}">${esc(authorName(who(c.author)))}</a>`;
  const authorAvatar = (c) => `<a class="avatar-link" href="${esc(authorURL(who(c.author)))}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${avatar(c.author)}</a>`;

  function composer({ reply } = {}) {
    const me = state.me;
    const handle = me && profiles.get(me)?.handle;
    const as = me
      ? `<span class="who">${avatar(me).replace('class="avatar"', 'class="avatar" style="width:20px;height:20px"')}<span>as <b>${esc(authorName(who(me)))}</b></span></span>`
      : "";
    return `<form class="compose${reply ? " reply" : ""}" data-reply="${reply ?? ""}">
      <textarea name="text" maxlength="${records.MAX_TEXT * 2}" placeholder="${reply ? "Write a reply…" : "Join the discussion…"}" aria-label="${reply ? "Reply" : "Comment"}"></textarea>
      <div class="row">
        ${me ? as : ""}
        ${me && !reply ? `<a class="link" href="${MONIKER_APP}" target="_blank" rel="noopener">${handle ? "Change your handle or photo" : "Get a handle and photo"}</a>` : ""}
        ${reply ? `<button type="button" class="cancel" data-act="cancel">Cancel</button>` : ""}
        <button class="post" type="submit" ${state.busy ? "disabled" : ""}>${me ? (reply ? "Reply" : "Post") : "Sign in to post"}</button>
      </div>
      ${reply ? "" : `<p class="note">${me ? "Posting opens Selfhold to sign. This device pays with a few seconds of work: no coins, no captcha." : "No account to make: Selfhold signs your comment with a passkey on this device, and a few seconds of its work pays for it. No email, no captcha, no ads."}</p>`}
      ${reply ? "" : `<p class="status${state.bad ? " bad" : ""}" role="status" ${state.status ? "" : "hidden"}>${esc(state.status)}</p>`}
    </form>`;
  }

  function item(c, depth) {
    if (c.missing) {
      return `<li class="c gone"><div class="body"><span class="avatar"></span><p class="text">This comment was deleted.</p></div>${children(c, depth)}</li>`;
    }
    const key = keyOf(c);
    const muted = state.muted.has(c.author);
    const hiddenBy = state.hidden.comments.has(key) || state.hidden.accounts.has(c.author) || muted;
    if (hiddenBy && (muted || !isMod()) && !state.reveal.has(key)) {
      return `<li class="c"><p class="hidden-note">${muted ? "You muted this author." : "Hidden by the site's moderators."} <button class="link" data-act="reveal" data-key="${key}">Show</button></p>${children(c, depth)}</li>`;
    }
    const saving = state.likes.get(key);
    const liked = saving ?? (state.me !== null && c.likes.includes(state.me));
    const likes = c.likes.length + (saving === undefined ? 0 : saving && !c.likes.includes(state.me) ? 1 : !saving && c.likes.includes(state.me) ? -1 : 0);
    const mine = state.me === c.author;
    const stale = c.pending && (c.dropped || Date.now() - c.sentAt > STALE);
    const tips = c.tips ?? { count: 0, total: 0n };
    const tipSent = state.tipping.has(key);
    const acts = c.pending
      ? stale
        ? `<div class="acts"><button data-act="retry-send" data-key="${key}">Retry</button><button data-act="discard" data-key="${key}">Discard</button></div>`
        : ""
      : `<div class="acts">
          <button data-act="reply" data-key="${key}">Reply</button>
          <button data-act="like" data-key="${key}" aria-pressed="${liked}" aria-label="${liked ? "Unlike" : "Like"}">♥ ${likes || ""}</button>
          ${mine ? "" : `<button data-act="tip" data-key="${key}" aria-expanded="${state.tipFor === key}">${tipSent ? "Tip sending…" : "Tip"}</button>`}
          ${tips.count ? `<span class="tipbadge">★ ${esc(tipsLabel(tips))}</span>` : ""}
          ${mine ? `<button data-act="delete" data-key="${key}">Delete</button>` : ""}
          ${isMod() && !mine ? `<button data-act="hide" data-key="${key}">${state.hidden.comments.has(key) ? "Unhide" : "Hide"}</button><button data-act="block" data-key="${key}">${state.hidden.accounts.has(c.author) ? "Unblock author" : "Block author"}</button>` : ""}
          ${state.me && !mine ? `<button data-act="mute" data-key="${key}">${muted ? "Unmute author" : "Mute author"}</button>` : ""}
        </div>
        ${state.tipFor === key ? tipper(key) : ""}`;
    return `<li class="c${c.pending ? " pending" : ""}${hiddenBy ? " marked" : ""}${tips.count ? " tipped" : ""}" id="c-${c.id}">
      <div class="body">
        ${authorAvatar(c)}
        <div class="meta" ${c.pending ? `data-state="${stale ? (c.dropped ? "Not saved: it didn't go through" : "Not saved: it may not have gone through") : esc(c.pending)}"` : ""}>${nameOf(c)}${mine ? `<span class="you">you</span>` : ""}${c.answers && depth >= DEPTH ? `<span>↪ ${c.answers.missing ? "a deleted comment" : nameOf(c.answers)}</span>` : ""}${c.pending ? "" : `<a href="#c-${c.id}" title="${esc(new Date(c.at).toLocaleString())}" style="color:inherit;text-decoration:none">${esc(ago(c.at))}</a>`}${hiddenBy ? "<span>hidden</span>" : ""}</div>
        <div class="text">${renderText(c.text)}</div>
        ${acts}
      </div>
      ${state.replyTo === key ? composer({ reply: key }) : ""}
      ${children(c, depth)}
    </li>`;
  }

  /** The Tip control: a few amounts, and whether the reader's coins cover the one chosen. */
  function tipper(key) {
    const check = tipCheck(state.tipAmount, state.balance);
    return `<div class="tipper" role="group" aria-label="Tip the author">
      <span>Tip the author</span>
      ${TIP_AMOUNTS.map((n) => `<button class="amount" data-act="tip-amount" data-key="${key}" data-amount="${n}" aria-pressed="${state.tipAmount === n}">${n}</button>`).join("")}
      <button class="post" data-act="tip-send" data-key="${key}" ${check.ok && !state.busy ? "" : "disabled"}>Send ${count(state.tipAmount, "coin")}</button>
      <button class="cancel" data-act="tip-cancel">Cancel</button>
      <p class="note" role="status">${esc(check.text)}</p>
    </div>`;
  }

  /** A comment's replies. Past DEPTH they stay at one indent, each saying whom it answers. */
  const children = (c, depth) => {
    if (!c.replies?.length) return "";
    if (depth + 1 < DEPTH) return `<ol>${c.replies.map((r) => item(r, depth + 1)).join("")}</ol>`;
    const flat = [];
    const walk = (parent, nodes) => nodes.forEach((n) => (flat.push({ ...n, answers: parent, replies: [] }), walk(n, n.replies ?? [])));
    walk(c, c.replies);
    return `<ol>${flat.map((r) => item(r, DEPTH)).join("")}</ol>`;
  };

  function threads() {
    const all = [...state.comments, ...state.pending.map((p) => ({ ...p, likes: [], pending: p.state ?? "Saving… this takes a few minutes" }))];
    const top = records.tree(all);
    const score = (c) => (c.missing ? 0 : c.likes.length) + (c.replies?.length ?? 0) * 0.5;
    const time = (c) => (c.missing ? c.replies[0]?.id : c.id) ?? "";
    if (state.sort === "newest") top.sort((a, b) => (time(a) < time(b) ? 1 : -1));
    if (state.sort === "top") top.sort((a, b) => score(b) - score(a) || (time(a) < time(b) ? -1 : 1));
    return top;
  }

  function render() {
    // Keep what the person is typing across a redraw.
    const drafts = [...view.querySelectorAll("form.compose")].map((f) => [f.dataset.reply, f.text.value, f.contains(root.activeElement) ? root.activeElement.name : null]);
    const total = state.comments ? state.comments.filter((c) => !c.missing).length + state.pending.length : 0;
    let body;
    if (state.comments === null) body = state.error ? `<p class="empty">Comments couldn't load: no host is answering. <button class="link" data-act="retry">Try again</button></p>` : `<p class="loading">Loading comments…</p>`;
    else {
      const top = threads();
      body = top.length ? `<ol>${top.slice(0, state.shown).map((c) => item(c, 0)).join("")}</ol>${top.length > state.shown ? `<button class="more" data-act="more">Show ${Math.min(PAGE_SIZE, top.length - state.shown)} more</button>` : ""}` : `<p class="empty">No comments yet. Start the conversation.</p>`;
    }
    view.innerHTML = `
      <div class="head"><h2>${state.comments ? count(total, "comment") : "Comments"}</h2>
        <div class="sort" role="group" aria-label="Sort comments">${["oldest", "newest", "top"].map((s) => `<button data-act="sort" data-sort="${s}" aria-pressed="${state.sort === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
      </div>
      ${composer()}
      ${body}
      <div class="foot"><span><a href="${HOME}" target="_blank" rel="noopener">Riposte</a>: comments with no accounts, ads or tracking</span>${state.me ? `<span>${isMod() ? "Moderating · " : ""}<button class="link" data-act="signout">Sign out</button></span>` : moderators.length ? `<button class="link" data-act="signin">Moderator sign-in</button>` : ""}</div>`;
    for (const [reply, text, focused] of drafts) {
      const form = view.querySelector(`form.compose[data-reply="${reply ?? ""}"]`);
      if (!form) continue;
      form.text.value = text;
      if (focused) form[focused]?.focus();
    }
  }

  // ------------------------------------------------------------ acting

  function say(text, bad = false) {
    state.status = text;
    state.bad = bad;
    const line = view.querySelector("form.compose:not(.reply) .status");
    if (line) {
      line.textContent = text;
      line.hidden = !text;
      line.classList.toggle("bad", bad);
    }
  }

  async function signIn() {
    try {
      say("Opening Selfhold…");
      state.me = await wallet.connect();
      lookUp([state.me]);
      say("");
    } catch (error) {
      say(walletMessage(error), true);
    }
    render();
    return state.me;
  }

  /** Sends one write through Selfhold, saying how it goes; true once it's sent. */
  async function writing(run) {
    if (!state.me) return false;
    state.busy = true;
    try {
      // A host refuses a second write while the account's last still waits.
      const last = state.inflight?.account === state.me ? await fate(state.inflight) : "landed";
      if (last === "waiting") {
        say("Your last change is still saving. Try this once it's in.", true);
        return false;
      }
      if (last === "dropped") lost(state.inflight);
      settle(null);
      say("Approve it in Selfhold…");
      const answer = await run({ wallet, account: state.me, progress: (text) => say(`${text}…`.replace(/[.…]+…$/, "…")) });
      const sent = answer?.sent ?? answer;
      if (sent?.transactionCID && sent.host && sent.nonce !== undefined) {
        settle({ cid: sent.transactionCID, nonce: String(sent.nonce), host: sent.host, account: state.me, chain: chain.join("/"), at: Date.now() });
      }
      say("");
      return true;
    } catch (error) {
      if (/may still land/i.test(String(error?.message))) return (say(""), true);
      if (error?.code === "AccountChanged" || error?.code === "NotConnected") state.me = await wallet.address().catch(() => null);
      say(walletMessage(error), true);
      return false;
    } finally {
      state.busy = false;
      render();
    }
  }

  /**
   * Re-reads every few seconds until `done()` holds. Past STALE it stops and
   * says so: a write that hasn't landed by then probably never will.
   */
  function settle(sent) {
    state.inflight = sent;
    store.set(INFLIGHT, sent ?? undefined);
  }
  /** `sent` won't land: a comment it carried offers Retry; true if one did. */
  function lost(sent) {
    let carried = false;
    for (const p of state.pending) if (p.cid === sent.cid) carried = p.dropped = true;
    store.set(PENDING, state.pending.length ? state.pending : undefined);
    state.likes.clear();
    return carried;
  }
  let watching = null;
  function watch(done, { stuck = "That hasn't gone through after 20 minutes. Try again.", dropped = "That didn't go through. Try again." } = {}) {
    const started = Date.now();
    const sent = state.inflight;
    clearInterval(watching);
    watching = setInterval(async () => {
      await load();
      if (done()) return (clearInterval(watching), sent === state.inflight && settle(null));
      // The host let go of it without it landing: nothing will bring it back.
      const now = sent && sent === state.inflight ? await fate(sent) : "waiting";
      if (now === "landed") settle(null);
      if (now === "dropped") {
        clearInterval(watching);
        settle(null);
        if (!lost(sent) && dropped) say(dropped, true);
        return render();
      }
      if (Date.now() - started > STALE) {
        clearInterval(watching);
        if (stuck) say(stuck, true);
        render();
      }
    }, 6000);
  }
  const find = (key) => state.comments?.find((c) => keyOf(c) === key);
  const refOf = (key) => {
    const [author, id] = key.split("/");
    return { author, id };
  };

  async function submit(form) {
    const text = form.text.value;
    const reply = form.dataset.reply || null;
    if (!text.trim()) return form.text.focus();
    if (!state.me) {
      // A first comment: Selfhold makes or picks an account; then Post sends it.
      if (await signIn()) say("Signed in. Press Post to send your comment.");
      return;
    }
    let draft;
    try {
      draft = records.comment(page.key, state.me, { text, ...(reply && { reply: refOf(reply) }) });
    } catch (error) {
      return say(error.message, true);
    }
    const id = draft.id;
    const ok = await writing(async (how) => {
      return page.comment({ id, text, ...(reply && { reply: refOf(reply) }) }, how);
    });
    if (!ok) return;
    // Shown at once, as saving, until it is in a block.
    const value = records.parseComment(draft.actions[0].newValue);
    state.pending.push({ author: state.me, id: draft.id, at: Date.now(), ...value, sentAt: Date.now(), cid: state.inflight?.cid });
    store.set(PENDING, state.pending);
    if (reply) state.replyTo = null;
    const box = view.querySelector(`form.compose[data-reply="${reply ?? ""}"]`);
    if (box) box.text.value = "";
    render();
    watch(() => state.pending.length === 0, { stuck: null });
  }

  /** Sends a pending comment again, under the same id: if the first did land, the chain keeps one. */
  async function resend(key) {
    const p = state.pending.find((x) => keyOf(x) === key);
    if (!p || p.author !== state.me) return say("Sign in as the account that wrote it to retry.", true);
    const ok = await writing((how) => page.comment({ id: p.id, text: p.text, ...(p.reply && { reply: p.reply }) }, how));
    if (!ok) return;
    p.sentAt = Date.now();
    p.cid = state.inflight?.cid;
    delete p.dropped;
    store.set(PENDING, state.pending);
    render();
    watch(() => state.pending.length === 0, { stuck: null });
  }

  view.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.busy) submit(event.target);
  });
  view.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target.name === "text") {
      event.preventDefault();
      if (!state.busy) submit(event.target.form);
    }
    if (event.key === "Escape" && event.target.closest("form.reply")) {
      state.replyTo = null;
      render();
    }
  });
  view.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const { act, key } = button.dataset;
    if (act === "retry") return load();
    if (act === "more") return ((state.shown += PAGE_SIZE), render());
    if (act === "sort") return ((state.sort = button.dataset.sort), store.set("riposte.sort", state.sort), render());
    if (act === "reveal") return (state.reveal.add(key), render());
    if (act === "discard") {
      state.pending = state.pending.filter((p) => keyOf(p) !== key);
      store.set(PENDING, state.pending.length ? state.pending : undefined);
      return render();
    }
    if (act === "signin") return signIn();
    if (act === "signout") {
      await wallet.disconnect();
      state.me = null;
      return render();
    }
    if (act === "cancel") return ((state.replyTo = null), render());
    if (act === "tip-cancel") return ((state.tipFor = null), render());
    if (act === "tip-amount") return ((state.tipAmount = Number(button.dataset.amount)), render());
    if (act === "reply") {
      state.replyTo = state.replyTo === key ? null : key;
      render();
      return view.querySelector("form.reply textarea")?.focus();
    }
    if (state.busy) return;
    if (!state.me && !(await signIn())) return;
    if (act === "retry-send") return resend(key);
    const to = refOf(key);
    if (act === "tip") {
      if (state.tipFor === key) return ((state.tipFor = null), render());
      state.tipFor = key;
      state.balance = null;
      render();
      try {
        state.balance = await riposte.balance(state.me);
      } catch (error) {
        say(walletMessage(error), true);
        state.tipFor = null;
      }
      return render();
    }
    if (act === "tip-send") {
      const amount = state.tipAmount;
      if (!tipCheck(amount, state.balance).ok) return;
      const total = (find(key)?.tips.total ?? 0n) + BigInt(amount);
      if (await writing((how) => page.tip(to, amount, how))) {
        state.tipFor = null;
        state.tipping.set(key, total);
        say(`Tipping ${count(amount, "coin")}… this takes a few minutes.`);
        watch(() => !state.tipping.has(key) && (say(""), true));
      } else if (state.tipFor === key) {
        // Refused for want of coins, maybe: the control shows the balance as it is now.
        state.balance = await riposte.balance(state.me).catch(() => state.balance);
        render();
      }
      return;
    }
    if (act === "mute") {
      const on = !state.muted.has(to.author);
      if (await writing((how) => page.mute(to.author, how, on))) watch(() => state.muted.has(to.author) === on);
      return;
    }
    if (act === "like") {
      const on = !(state.likes.get(key) ?? find(key)?.likes.includes(state.me));
      state.likes.set(key, on);
      render();
      if (await writing((how) => page.like(to, how, on))) watch(() => !state.likes.has(key));
      else (state.likes.delete(key), render());
    }
    if (act === "delete") {
      if (await writing((how) => page.remove(to.id, how))) {
        say("Deleting… this takes a few minutes.");
        watch(() => !find(key));
      }
    }
    if (act === "hide") {
      const on = !state.hidden.comments.has(key);
      if (await writing((how) => page.hide(to, how, on))) watch(() => state.hidden.comments.has(key) === on);
    }
    if (act === "block") {
      const on = !state.hidden.accounts.has(to.author);
      if (await writing((how) => page.block(to.author, how, on))) watch(() => state.hidden.accounts.has(to.author) === on);
    }
  });

  render();
  await load();
  if (state.pending.length) watch(() => state.pending.length === 0, { stuck: null });
  // A stale comment's Retry appears without a reload.
  setInterval(() => state.pending.some((p) => Date.now() - p.sentAt > STALE) && render(), 60_000);
  // New comments from others, while the page is open and visible.
  setInterval(() => document.visibilityState === "visible" && !state.busy && !view.querySelector("form.reply textarea:focus") && load(), 60_000);
  // Signed in elsewhere on this site (another tab): pick it up.
  window.addEventListener("storage", async () => {
    const me = await wallet.address().catch(() => null);
    if (me !== state.me) ((state.me = me), me && lookUp([me]), render());
  });
}

const targets = () => document.querySelectorAll("#riposte, [data-riposte]");
const start = () => targets().forEach((element) => mount(element).catch((error) => console.error("Riposte:", error)));
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
