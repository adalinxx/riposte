// What the widget shows for a comment's author, from Moniker and the comment.
import { displayName } from "../vendor/moniker/records/names.mjs";
import { shortAccount } from "../src/account.mjs";

/**
 * The author's name: `{ text, id? }`. Their verified Moniker `handle` ("@h"),
 * else their Moniker card's name with their short account ID beside it (`id`:
 * anyone may copy a card's name), else the name given with the comment, else
 * their short account ID. Every name is cleaned as Moniker cleans a card's,
 * so only a verified handle shows with an @. Plain text: escape it to draw it.
 */
export function authorName({ address, handle, card, name }) {
  if (handle) return { text: `@${handle}` };
  const carded = displayName(card?.name);
  if (carded) return { text: carded, id: shortAccount(address) };
  return { text: displayName(name) ?? shortAccount(address) };
}
