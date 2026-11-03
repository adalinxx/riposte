# Riposte

Comments for static sites, with no server, no sign-up and no ads. A
Disqus or giscus replacement that is one script tag.

```html
<div id="riposte"></div>
<script type="module" src="https://adalinxx.github.io/riposte/riposte.js"></script>
```

**Try it:** https://adalinxx.github.io/riposte/ (a guestbook) and
https://adalinxx.github.io/riposte/demo/ (a blog post). Both run on testnet.

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

## Install

Put the tag where comments should appear. The element may also say:

| Attribute | Meaning |
| --- | --- |
| `data-page` | the thread's name. Default: the page's host and path, without `www.`, the query, the fragment, `index.html` or a trailing slash. |
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

`<page>` is SHA-256 of the page's name, in lowercase base 32, cut to 32
characters. One prefix read finds a page's comments, and another its likes.
An `<id>` is the comment's time in milliseconds in base 36 (9 characters)
followed by 4 random characters, so comments sort by time. `reply` is
`{ author, id }`. A reply whose parent is gone shows under "This comment was
deleted.". The policy (`policy/`) checks only who signs, how keys are spelled
and how big values are. It never reads JSON.

Clients cap a comment at 2,000 characters and a name at 40.

## Use it from code

```js
import * as sdk from "./vendor/lattice-sdk.js";
import { createRiposte } from "./src/index.mjs";

const riposte = createRiposte({ sdk });              // or { chain, nodes }
const page = await riposte.page(location.href);      // or riposte.page({ name: "my-post" })
await page.comments();                               // oldest first: { author, id, at, text, name?, reply?, likes }
await page.hidden([moderator]);                      // { comments: Set<"author/id">, accounts: Set }
const how = { wallet, account };                     // wallet: Selfhold's client
await page.comment({ text, name, reply }, how);      // { id, sent }
await page.like({ author, id }, how);                // page.like(to, how, false) unlikes
await page.remove(id, how);
await page.hide({ author, id }, how);  await page.block(account, how);
```

`records.tree(comments)` nests replies.

## Layout

- `riposte.js`: the widget. `widget/text.mjs` holds its text and time helpers.
- `src/`: the library. `records.mjs` holds the records, `state.mjs` reads
  state by walking the trie (from Murmur), and `wallet.mjs` builds the
  wallet request with no fee.
- `policy/`: the chain's validity policy (Rust, built to wasm), on
  `lattice-policy-rules` from Moniker. `policy/host-check/` replays the test
  contexts through Lattice's own evaluator. `chain/` holds the spec and the
  built module.
- `index.html`: the landing page. `demo/` is a blog post with the widget.
- `vendor/`: the Lattice SDK bundled for browsers, and Selfhold's client.

## Test

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
LATTICE=<lattice-node>/.build/debug/lattice node e2e/riposte.mjs
```

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

The trial chain is `Nexus/testnet/riposte-bc49ba`, from `chain/spec.json`
(policy module `bafyreigajyzr5o7ygzhz77jhvymxq3r6s5bgm72wdd4jjzf43iu7djcoae`).
It was created on the operator's Mac node, which merge-mines it. Its premine
goes to a test key that is not in this repository. The shared testnet app
hosts `lattice-testnet-apps-iad` and `-ams` host it. The fee sponsor on iad
pays Riposte's fees from a float of 100,000 sent from the premine.
