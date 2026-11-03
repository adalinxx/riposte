// The widget's pure parts: how comment text and times are shown. Nothing
// here reads a chain or touches the page.

export const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const LINK = /\bhttps?:\/\/[^\s<>"']+/gi;
// Punctuation that usually ends a sentence rather than a link.
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * A comment's text as HTML: escaped, with http(s) links linked (nofollow,
 * marked as user content) and line breaks kept by the stylesheet. Nothing a
 * comment says becomes markup of its own.
 */
export function renderText(text) {
  let out = "";
  let last = 0;
  for (const match of String(text).matchAll(LINK)) {
    let url = match[0];
    // Keep a closing parenthesis that closes one opened inside the link.
    const cut = url.match(TRAILING)?.[0] ?? "";
    let keep = url.length - cut.length;
    if (cut.startsWith(")") && (url.slice(0, keep).match(/\(/g)?.length ?? 0) > (url.slice(0, keep).match(/\)/g)?.length ?? 0)) keep++;
    url = url.slice(0, keep);
    out += esc(text.slice(last, match.index));
    out += `<a href="${esc(url)}" rel="nofollow ugc noopener noreferrer" target="_blank">${esc(shorten(url))}</a>`;
    last = match.index + url.length;
  }
  return out + esc(String(text).slice(last));
}

/** A link as shown: without its scheme, and cut after 48 characters. */
function shorten(url) {
  const bare = url.replace(/^https?:\/\//i, "");
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
}

/** How long ago `at` (ms) was, in a few characters; a date once it's old. */
export function ago(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) {
    const d = Math.round(s / 86400);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(!sameYear && { year: "numeric" }) });
}

/** "1 comment", "2 comments". */
export const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
