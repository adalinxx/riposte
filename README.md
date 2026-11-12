# Riposte

Comments for static sites, with no server, no sign-up and no ads. A
Disqus or giscus replacement that is one script tag.

```html
<div id="riposte"></div>
<script type="module" src="https://riposte.page/riposte.js"></script>
```

**Try it:** https://riposte.page/ (a guestbook) and
https://riposte.page/demo/ (a blog post). Both run on testnet.

- **No account wall.** A reader's first comment makes a passkey in
  [Selfhold](https://wallet.selfhold.app/). There's no email, password or
  third-party login.
- **No captcha, no coins.** Each comment's fee is paid by a fee sponsor
  (`lattice-sponsor`) in exchange for a few seconds of the reader's device's
  work. Nobody holds a coin.
- **No backend.** Comments are records on Riposte's Lattice chain. The
  widget reads them from any node and checks every piece against its CID.
- **Moderators mark; they don't delete.** A comment can be deleted only by
  its writer. A site names its moderators, and the widget follows their
  marks on that site's pages: a hidden comment folds away, and a reader can
  still open it.
- **Tips.** A reader who holds coins can tip a useful comment. The coins go
  to its writer in the same transaction, and the comment is highlighted.
- **Any page.** `discuss/?url=<address>` shows the thread for any page, the
  same one an embed there would show. A bookmarklet on the landing page opens
  it for the page you're on.

**Handles and photos come from [Moniker](https://app.moniker.bio/).** A
comment is signed by the writer's account, the same on every chain, so the
widget looks its authors up on `Nexus/moniker`, from the same hosts, in one
read per thread, after the thread is drawn. An author shows as their verified
`@handle`, else their short account ID: never a name anyone can type, on a
card or with a comment. Their card's photo, checked by its CID and at most
256 KB, replaces the account's pattern, and the author links to their Moniker
page. Riposte never writes to Moniker: readers get a handle and photo in the
Moniker app. `vendor/moniker/` is moniker-sdk's reader.

## Install

Put the tag where comments should appear. The element may also say:

| Attribute | Meaning |
| --- | --- |
| `data-page` | the thread's name on this site. Default: the page's host and path, without `www.`, the query, the fragment, `index.html` or a trailing slash. |
| `data-moderators` | account IDs, comma-separated, whose marks this page follows |
| `data-chain`, `data-nodes`, `data-sponsor`, `data-wallet` | another chain, hosts, fee sponsor or Selfhold |

The widget draws into a shadow root. It inherits the page's font and text
color and takes its accent from the page's link color; set `--riposte-accent`
on the element to choose another. The landing page has snippets for Hugo,
Astro and Jekyll, and gives a moderator their ID.

To moderate, open a post, choose **Moderator sign-in** under the comments
and use the account named in `data-moderators`. **Hide** and **Block
author** then appear on each comment.

## Records

| Key | Value | Written by |
| --- | --- | --- |
| `comment/<page>/<a>/<id>` | `{ text, name?, reply? }`, at most 10,240 bytes | `<a>`: created or deleted, never edited |
| `like/<page>/<author>/<id>/<a>` | `1`: `<a>` likes the comment | `<a>` |
| `hide/<m>/<page>/<author>/<id>` | `1`: moderator `<m>` hides the comment | `<m>` |
| `block/<m>/<a>` | `1`: moderator `<m>` hides everything `<a>` writes | `<m>` |
| `mute/<a>/<muted>` | `1`: reader `<a>` hides everything `<muted>` writes, for themselves | `<a>` |
| `tip/<page>/<author>/<id>/<a>/<tid>` | the amount: `<a>` tipped the comment | `<a>`: created, never edited or deleted |

`<page>` is 32 characters: the site, then the page, each SHA-256 in
lowercase base 32 cut to 16 characters. The site is the page's host without
`www.`; the page is its name (`data-page`, or host and path). One prefix
read finds a page's comments, another its likes and another its tips. The
prefixes `comment/<site>`, `like/<site>` and `tip/<site>` hold everything
readers write on a site, so a fee sponsor's fund for the site can pay for
exactly those writes; the widget names them as `fund` in each write it asks
for (`page.fund`). Moderators' marks are not under them.

A tip's value is a whole number of coins, at least 1, written without
leading zeros. The same transaction must credit `<author>` at least that
much, `<a>` may not be `<author>`, and `<author>` may not sign it. Tips to one
author that come one after another are paid by one credit to them; each run
of tips needs its own credit, in the order the runs come. A tip is paid from
the tipper's coins: the widget checks the balance first and doesn't send a
tip it doesn't cover, and asks the wallet for `coinOnly`, so the wallet
refuses rather than buy a shortfall with work.

A mute is a reader's own mark, on every page they read signed in. It is not
a block: a moderator who mutes someone hides them only for themselves, never
on their site.
An `<id>` is the comment's time in milliseconds in base 36 (9 characters)
followed by 4 random characters, so comments sort by time. `reply` is
`{ author, id }`. A reply whose parent is gone shows under "This comment was
deleted.". The policy (`policy/`) checks who signs, how keys are spelled, how
big values are and that tips are paid. It never reads JSON.

Clients cap a comment at 2,000 characters and a name at 40.

## Use it from code

```js
import * as sdk from "./vendor/lattice-sdk.js";
import { createRiposte } from "./src/index.mjs";

const riposte = createRiposte({ sdk });              // or { chain, nodes }
const page = await riposte.page(location.href);      // or riposte.page({ name: "my-post", site: location.host })
await page.comments();                               // oldest first: { author, id, at, text, name?, reply?, likes, tips: { count, total } }
await page.hidden([moderator]);                      // { comments: Set<"author/id">, accounts: Set }
const how = { wallet, account };                     // wallet: Selfhold's client
await page.comment({ text, name, reply }, how);      // { id, sent }
await page.like({ author, id }, how);                // page.like(to, how, false) unlikes
await page.remove(id, how);
await page.hide({ author, id }, how);  await page.block(account, how);
await page.mute(account, how);  await page.muted(account); // a reader's own mutes, a Set
await page.tip({ author, id }, 5, how);              // 5 coins from the account's balance to the author
await riposte.balance(account);                      // coins, a BigInt
page.site; page.fund;                                // the site's key, and its fund prefixes
```

`records.tree(comments)` nests replies.

## Discuss any page

`discuss/?url=<address>` shows the thread for any http(s) address, keyed as
an embed on that page would key it (without `data-page`), with a link out to
the page. There are no moderators there: a signed-in reader can **Mute
author** (`mute/<me>/<author>`), as on any page with the widget, and a muted
author's comments fold away for them as a moderator's hidden ones do. The landing page has a bookmarklet that opens it for
the current page.

## Layout

- `riposte.js`: the widget. `widget/text.mjs` holds its text and time
  helpers, `widget/author.mjs` how it names an author.
- `src/`: the library. `records.mjs` holds the records, `state.mjs` reads
  state by walking the trie (from Murmur), and `wallet.mjs` builds the
  wallet request with no fee.
- `policy/`: the chain's validity policy (Rust, built to wasm), on
  `lattice-policy-rules` from Moniker. `policy/host-check/` replays the test
  contexts through Lattice's own evaluator. `chain/` holds the spec and the
  built module.
- `index.html`: the landing page. `demo/` is a blog post with the widget.
  `discuss/` shows any address's thread.
- `vendor/`: the Lattice SDK bundled for browsers (lattice-sdk 382bf8c, by
  `esbuild@0.24.2 packages/sdk/src/index.ts --bundle --format=esm --minify`),
  Selfhold's client, and moniker-sdk's reader (`vendor/moniker/`).

## Test

CI (`.github/workflows/test.yml`) runs all of the below on every push and
pull request, against a pinned node, fee sponsor and Selfhold. It also checks
that the policy source builds the exact module the chain runs.

```sh
npm run build:policy        # the policy, with this machine's paths left out of it
npm test                    # the policy, the records, the widget's helpers

CONTEXT_DIR=.contexts node --test test/policy.test.mjs
(cd policy/host-check && swift run -c release host-check \
  ../target/wasm32-unknown-unknown/release/riposte_policy.wasm ../../.contexts)
```

The end-to-end test runs on a private node that takes no fee under 1, with a
real fee sponsor beside it. Alice, Bob and a moderator never hold a coin:

```sh
LATTICE=<lattice-node>/.build/debug/lattice MONIKER=<moniker> node e2e/riposte.mjs
```

The node hosts Moniker too, from a checkout of `adalinxx/moniker` (`MONIKER`,
default `~/src/moniker`), and the moderator shows `@grace` with a photo.

`E2E_KEEP=<port>` then serves this repository on `<port>` against that node.
The browser test drives the widget on the demo post through Selfhold's window
with a virtual passkey. A reader signs in, comments, replies, likes and
deletes. Then the blog names them its moderator, they hide a comment, and a
second reader sees it folded:

```sh
(cd e2e/ui && npm install && \
  LATTICE=<lattice-node>/.build/debug/lattice LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web \
  node --test widget.test.mjs)
```

## Trial

The trial chain is `Nexus/testnet/riposte-1fab4d`, from `chain/spec.json`
(policy module `bafyreifd4hg4pewgxqej6twemu3f6cqznd5at35xha2wt62zn25w6jtd3u`).
It was created on the operator's Mac node, which merge-mines it. Its premine
goes to a test key that is not in this repository. The shared testnet app
hosts `lattice-testnet-apps-iad` and `-ams` host it. The fee sponsor on iad
pays Riposte's fees from a float of 100,000 sent from the premine, and
takes site funds (`--funds`), so a site can lend it more float for its own
pages.
