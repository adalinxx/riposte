// What the widget shows for a comment's author: Moniker's verified handle only.
import { shortAccount } from "../src/account.mjs";

const MONIKER_APP = "https://app.moniker.bio/";

/**
 * The author's name: their verified Moniker `handle` as "@h", else their short
 * account ID. Never a name anyone can type (a card's or a comment's): only a
 * handle is checked to be theirs. Plain text: escape it to draw it.
 */
export const authorName = ({ address, handle }) => (handle ? `@${handle}` : shortAccount(address));

/** The author's Moniker page: their handle's while they show one, else their account's. */
export const authorURL = ({ address, handle }) =>
  handle ? `${MONIKER_APP}#/@${encodeURIComponent(handle)}` : `${MONIKER_APP}#/account/${encodeURIComponent(address)}`;
