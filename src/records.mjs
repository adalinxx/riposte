// Riposte's records: comments under web pages, likes, and moderators' marks,
// each key belonging to the account named in it (the chain's policy).
//
//   comment/<page>/<a>/<id>        a comment: JSON { text, name?, reply? }
//   like/<page>/<author>/<id>/<a>  "1": <a> likes that comment
//   hide/<m>/<page>/<author>/<id>  "1": moderator <m> hides that comment
//   block/<m>/<a>                  "1": moderator <m> hides everything <a> writes
//
// <page> is the page's key: a hash of what names it (see `pageKey`), so one
// prefix read finds every comment under a page, and another every like.
// A comment is created once and deleted by its writer, never edited. Its id
// is its time in base 36 and a few random characters, so ids sort by time.
// Moderators only mark: a page follows the marks of the moderators it names,
// and a reader may still look at what they hid.
//
// Every read takes a state view `{ get(key), list(prefix) }`; every write
// returns `{ actions }` for the person's wallet to sign.

export const MAX_TEXT = 2000;
export const MAX_NAME = 40;
/** The most bytes the policy takes in one comment. */
export const MAX_VALUE = 10240;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Whether `text` is an account address in its one canonical spelling, as the policy checks it. */
export function isAddress(text) {
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

/** Whether `text` is a comment id: 1 to 16 lowercase letters and digits. */
export const isId = (text) => typeof text === "string" && /^[a-z0-9]{1,16}$/.test(text);
/** Whether `text` is a page key: 1 to 64 lowercase letters and digits. */
export const isPage = (text) => typeof text === "string" && /^[a-z0-9]{1,64}$/.test(text);

const TIME_DIGITS = 9; // base 36: milliseconds until the year 5188
/** A new comment id: the time, then four random characters, so ids sort by time. */
export function newId(now = Date.now(), random = Math.random) {
  const time = Math.floor(now).toString(36).padStart(TIME_DIGITS, "0");
  let tail = "";
  for (let i = 0; i < 4; i++) tail += Math.floor(random() * 36).toString(36);
  return time + tail;
}
/** When a comment with `id` was written, in milliseconds, or undefined for an id no client made. */
export function timeOf(id) {
  if (!isId(id) || id.length < TIME_DIGITS) return undefined;
  const time = parseInt(id.slice(0, TIME_DIGITS), 36);
  return Number.isSafeInteger(time) ? time : undefined;
}

/**
 * What names a page, from its address: host and path, without "www.", the
 * query, the fragment, a trailing "index.html" or a trailing slash. So
 * `https://www.example.com/posts/hello/` and `http://example.com/posts/hello`
 * share their comments.
 */
export function pageName(href) {
  const url = new URL(href);
  let path = url.pathname.replace(/\/index\.html?$/i, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return url.host.toLowerCase().replace(/^www\./, "") + path;
}

/** A page's key: SHA-256 of its name, in lowercase base 32, 32 characters (160 bits). */
export async function pageKey(name) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("A page needs a name.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name.trim())));
  let bits = 0, value = 0, out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 32) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

function need(test, what, value) {
  if (!test(value)) throw new Error(`not ${what}: ${value}`);
}
const ref = ({ author, id }) => (need(isAddress, "an account", author), need(isId, "a comment id", id), { author, id });

export const commentKey = (page, author, id) => (need(isPage, "a page", page), ref({ author, id }), `comment/${page}/${author}/${id}`);
export const likeKey = (page, to, account) => (need(isAddress, "an account", account), `like/${commentKey(page, to.author, to.id).slice("comment/".length)}/${account}`);
export const hideKey = (moderator, page, to) => (need(isAddress, "an account", moderator), `hide/${moderator}/${commentKey(page, to.author, to.id).slice("comment/".length)}`);
export const blockKey = (moderator, account) => (need(isAddress, "an account", moderator), need(isAddress, "an account", account), `block/${moderator}/${account}`);

/** The number of characters a person sees in `text`, counted as code points. */
export const length = (text) => [...text].length;

/** A comment's value as a comment: `{ text, name?, reply? }`, or undefined for anything else. */
export function parseComment(value) {
  let json;
  try {
    json = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  if (typeof json.text !== "string" || json.text.trim() === "" || length(json.text) > MAX_TEXT) return undefined;
  const comment = { text: json.text };
  if (typeof json.name === "string" && json.name.trim()) comment.name = [...json.name.trim()].slice(0, MAX_NAME).join("");
  if (json.reply !== undefined) {
    const to = json.reply;
    if (typeof to !== "object" || to === null || !isAddress(to.author) || !isId(to.id)) return undefined;
    comment.reply = { author: to.author, id: to.id };
  }
  return comment;
}

// ---------------------------------------------------------------- reads

/** The keys under `prefix` with exactly `segments` more segments, split. */
async function entries(state, prefix, segments) {
  const found = [];
  for await (const [key, value] of state.list(prefix)) {
    const parts = key.slice(prefix.length).split("/");
    if (parts.length === segments) found.push({ parts, value });
  }
  return found;
}

const oldestFirst = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.author < b.author ? -1 : 1);

/**
 * Every comment under `page`, oldest first, each with who likes it:
 * `{ author, id, at, text, name?, reply?, likes: [account] }`.
 */
export async function comments(state, page) {
  need(isPage, "a page", page);
  const [rows, likeRows] = await Promise.all([entries(state, `comment/${page}/`, 2), entries(state, `like/${page}/`, 3)]);
  const likes = new Map();
  for (const { parts: [author, id, account] } of likeRows) {
    if (!isAddress(author) || !isId(id) || !isAddress(account)) continue;
    const key = `${author}/${id}`;
    likes.set(key, [...(likes.get(key) ?? []), account]);
  }
  const found = [];
  for (const { parts: [author, id], value } of rows) {
    const comment = isAddress(author) && isId(id) && parseComment(value);
    if (comment) found.push({ author, id, at: timeOf(id), ...comment, likes: likes.get(`${author}/${id}`) ?? [] });
  }
  return found.sort(oldestFirst);
}

/**
 * What `moderators` hide under `page`: `{ comments: Set<"author/id">,
 * accounts: Set<account> }`. Each moderator's marks are two prefix reads.
 */
export async function hidden(state, page, moderators) {
  need(isPage, "a page", page);
  const marks = { comments: new Set(), accounts: new Set() };
  await Promise.all(
    [...new Set(moderators)].filter(isAddress).map(async (m) => {
      const [hides, blocks] = await Promise.all([entries(state, `hide/${m}/${page}/`, 2), entries(state, `block/${m}/`, 1)]);
      for (const { parts: [author, id] } of hides) if (isAddress(author) && isId(id)) marks.comments.add(`${author}/${id}`);
      for (const { parts: [account] } of blocks) if (isAddress(account)) marks.accounts.add(account);
    }),
  );
  return marks;
}

/**
 * Comments as a tree: `[{ ...comment, replies: [...] }]`, oldest first at each
 * level. A reply whose parent is gone hangs under a stand-in
 * `{ author, id, missing: true }`, so the conversation keeps its shape; a
 * reply to a comment on another page, or to itself, stands at the top.
 */
export function tree(list) {
  const byKey = new Map(list.map((c) => [`${c.author}/${c.id}`, { ...c, replies: [] }]));
  const parentOf = (node) => node.reply && `${node.reply.author}/${node.reply.id}`;
  /** Whether following replies up from `node` comes back to it. */
  const inCycle = (node) => {
    const seen = new Set();
    for (let at = parentOf(node); at && byKey.has(at); at = parentOf(byKey.get(at))) {
      if (at === `${node.author}/${node.id}`) return true;
      if (seen.has(at)) return false;
      seen.add(at);
    }
    return false;
  };
  const top = [];
  const missing = new Map();
  for (const node of byKey.values()) {
    const to = parentOf(node);
    if (!to || inCycle(node)) top.push(node);
    else if (byKey.has(to)) byKey.get(to).replies.push(node);
    else {
      if (!missing.has(to)) {
        const stand = { ...node.reply, missing: true, replies: [] };
        missing.set(to, stand);
        top.push(stand);
      }
      missing.get(to).replies.push(node);
    }
  }
  const order = (nodes) => {
    nodes.sort(oldestFirst);
    nodes.forEach((n) => order(n.replies));
  };
  top.forEach((n) => order(n.replies));
  // A stand-in sorts where its first reply would.
  const first = (n) => (n.missing ? n.replies[0] : n);
  top.sort((a, b) => oldestFirst(first(a), first(b)));
  return top;
}

// ---------------------------------------------------------------- writes

/**
 * A new comment by `author` under `page`: `{ text, name?, reply? }`.
 * Returns `{ id, actions }`.
 */
export function comment(page, author, { text, name, reply }, { id = newId() } = {}) {
  if (typeof text !== "string" || text.trim() === "") throw new Error("Write something first.");
  if (length(text) > MAX_TEXT) throw new Error(`A comment is at most ${MAX_TEXT} characters.`);
  const body = { text: text.trim() };
  if (typeof name === "string" && name.trim()) {
    if (length(name.trim()) > MAX_NAME) throw new Error(`A name is at most ${MAX_NAME} characters.`);
    body.name = name.trim();
  }
  if (reply) body.reply = ref(reply);
  const value = JSON.stringify(body);
  if (new TextEncoder().encode(value).length > MAX_VALUE) throw new Error("That comment is too long to keep.");
  return { id, actions: [{ key: commentKey(page, author, id), newValue: value }] };
}

/** `author` deletes their comment `id` under `page`. Nothing if it is gone. */
export async function remove(state, page, author, id) {
  const oldValue = await state.get(commentKey(page, author, id));
  if (oldValue === undefined) return { actions: [] };
  return { actions: [{ key: commentKey(page, author, id), oldValue }] };
}

/** Sets a marker key to "1" (`on`) or deletes it, unless it is that way already. */
async function mark(state, key, on) {
  const now = await state.get(key);
  if (on === (now !== undefined)) return { actions: [] };
  return { actions: [on ? { key, newValue: "1" } : { key, oldValue: now }] };
}

/** `account` likes (or, with `on` false, stops liking) the comment `to` under `page`. */
export const like = (state, page, account, to, on = true) => mark(state, likeKey(page, to, account), on);
/** Moderator `m` hides (or shows again) the comment `to` under `page`. */
export const hide = (state, page, m, to, on = true) => mark(state, hideKey(m, page, to), on);
/** Moderator `m` hides (or shows again) everything `account` writes. */
export const block = (state, m, account, on = true) => mark(state, blockKey(m, account), on);
