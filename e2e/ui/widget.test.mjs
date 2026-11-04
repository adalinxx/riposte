// The widget on a blog page, through Selfhold's window, against a private
// stack (../riposte.mjs, run with E2E_KEEP so it stays up and serves this
// repository). A reader who holds no coins writes a comment: the first Post
// signs them in with a passkey, the second sends it, and it shows as saving
// until it lands. They reply, like and delete. Then the blog names them as
// its moderator: they hide a comment, and a second reader sees it hidden.
// With no coins the Tip control says so and sends nothing; given coins, they
// tip a comment from their balance and it is highlighted. The discuss page
// shows the post's thread from its address alone, and a reader mutes an
// author there for themselves.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_WALLET_WEB=<selfhold-wallet>/dist-web node --test e2e/ui/widget.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect, firefox, webkit } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 180_000 });
const walletWeb = process.env.LATTICE_WALLET_WEB && resolve(process.env.LATTICE_WALLET_WEB);
if (!walletWeb) throw new Error("LATTICE_WALLET_WEB: Selfhold's window, built (selfhold-wallet's dist-web/)");

// The stack: a node, the Riposte chain, a fee sponsor, a few comments, and this repository served on BLOG.
const BLOG = 29300;
let keepFile;
const stack = spawn(process.execPath, [fileURLToPath(new URL("../riposte.mjs", import.meta.url))], { env: { ...process.env, E2E_KEEP: String(BLOG) }, stdio: ["ignore", "pipe", "inherit"] });
const keep = await new Promise((done, fail) => {
  let out = "";
  stack.stdout.on("data", (chunk) => {
    out += chunk;
    process.stdout.write(chunk);
    const found = /^KEEP (.+)$/m.exec(out);
    if (found) done(JSON.parse(readFileSync((keepFile = found[1]), "utf8")));
  });
  stack.on("exit", (code) => fail(new Error(`the stack stopped (${code})`)));
});

// Selfhold's window, from its own origin, as wallet.selfhold.app.
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm", ".json": "application/json" };
const walletServer = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(walletWeb, path);
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return response.writeHead(404).end();
  }
  response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(response);
}).listen(29392, "127.0.0.1");
const walletPage = "http://localhost:29392/";
const walletOrigin = new URL(walletPage).origin;

const demo = (extra = "") => `${keep.demo}&wallet=${encodeURIComponent(walletPage)}${extra}`;

let browser, context, page, walletWindow;
const errors = [];
before(async () => {
  // Pop-ups blocked as for anyone: Selfhold's window opens only from a click.
  browser = await chromium.launch({ ignoreDefaultArgs: ["--disable-popup-blocking"] });
  context = await browser.newContext();
  // Selfhold's window stays open, and every request reuses it, numbered, so
  // the passkey the virtual authenticator holds there is the same each time.
  await context.addInitScript((origin) => {
    if (location.origin === origin) window.close = () => {};
  }, walletOrigin);
  await context.addInitScript((port) => {
    if (location.port !== String(port)) return;
    const open = window.open.bind(window);
    window.open = (url, _name, features) => {
      const to = new URL(url);
      const n = Number(sessionStorage.getItem("requests") ?? 0) + 1;
      sessionStorage.setItem("requests", String(n));
      to.searchParams.set("n", String(n));
      return open(to.href, "selfhold-test", features);
    };
  }, BLOG);
  context.on("page", async (popup) => {
    if (walletWindow || !(await popup.opener().catch(() => null))) return;
    walletWindow = popup;
    const cdp = await context.newCDPSession(popup);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    });
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
});
after(async () => {
  await browser?.close();
  walletServer.close();
  stack.kill();
  await new Promise((done) => stack.on("exit", done));
});

const test = (name, body) =>
  nodeTest(name, { timeout: 900_000 }, async () => {
    try {
      await body();
      assert.deepEqual(errors, [], "no page errors");
    } catch (error) {
      if (process.env.UI_SHOT) await page.screenshot({ path: process.env.UI_SHOT, fullPage: true }).catch(() => {});
      error.message += `\n--- widget:\n${(await widget().innerText().catch(() => "")).slice(0, 1500)}`;
      if (reader) error.message += `\n--- the reader on the chain: ${JSON.stringify(await (await fetch(`${keep.node}/api/state/account/${reader}?chainPath=${keep.chain}`, { cache: "no-store" })).json().catch(() => null))}`;
      if (process.env.UI_LOGS) {
        // The node's and the sponsor's logs, to see what became of a write.
        const { dirname, join } = await import("node:path");
        const { cpSync, existsSync } = await import("node:fs");
        const root = dirname(keepFile);
        for (const part of ["log", "sponsor.log"]) if (existsSync(join(root, part))) cpSync(join(root, part), join(process.env.UI_LOGS, part), { recursive: true });
      }
      if (walletWindow) error.message += `\n--- Selfhold's window:\n${(await walletWindow.locator("body").innerText({ timeout: 2000 }).catch(() => "(closed)")).slice(0, 800)}`;
      throw error;
    }
  });

// Playwright's locators pierce the widget's open shadow root.
const widget = () => page.locator("#riposte section.rp");
// The innermost comment saying `text`: replies sit inside the comment they answer.
const comment = (text) => widget().locator("li.c").filter({ hasText: text }).last();
const until = async (label, condition, seconds) => {
  const deadline = Date.now() + seconds * 1000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

/** Presses `button`, then waits for Selfhold's window to show that request. */
async function inSelfhold(button) {
  const n = Number(await page.evaluate(() => sessionStorage.getItem("requests") ?? 0)) + 1;
  await button.click();
  await until(`Selfhold's window, request ${n}`, async () => walletWindow && new URL(walletWindow.url()).searchParams.get("n") === String(n), 30);
  await walletWindow.bringToFront();
  return walletWindow;
}
const approve = async (button) => {
  const opened = await inSelfhold(button);
  await opened.getByRole("button", { name: "Approve with your passkey" }).click();
  await page.bringToFront();
};
let reader;
const balance = async (address) => {
  const response = await fetch(`${keep.node}/api/state/account/${address}?chainPath=${keep.chain}`, { cache: "no-store" });
  return response.ok ? BigInt((await response.json()).balance ?? 0) : 0n;
};

test("a reader with no coins signs in with a passkey and comments", async () => {
  await page.goto(demo());
  await expect(widget().locator("h2")).toHaveText("5 comments");
  await expect(comment("Does this work with Hugo?")).toContainText("Grace");
  // Moderated: the spam is folded away for a reader.
  await expect(widget().locator(".hidden-note")).toHaveCount(1);
  await expect(widget()).not.toContainText("BUY CHEAP WATCHES");

  await widget().getByLabel("Comment", { exact: true }).fill("First time here. Does it work with Astro too?");
  await widget().getByLabel("Your name").fill("Lin");
  const opened = await inSelfhold(widget().getByRole("button", { name: "Sign in to post" }));
  await opened.getByRole("button", { name: "Create an account" }).click();
  await opened.getByRole("button", { name: "Connect", exact: true }).click();
  await page.bringToFront();
  await expect(widget().locator(".status")).toHaveText("Signed in. Press Post to send your comment.");
  // The draft survived signing in.
  await expect(widget().getByLabel("Comment", { exact: true })).toHaveValue("First time here. Does it work with Astro too?");
  await expect(widget().locator(".who b")).toHaveText("Lin");
  reader = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("selfhold.web.address"))?.[1]);
  assert.ok(reader?.startsWith("bafyrei"), "signed in");

  await approve(widget().getByRole("button", { name: "Post", exact: true }));
  // Shown at once, as saving; then it lands.
  await expect(comment("Does it work with Astro too?")).toHaveClass(/pending/, { timeout: 60_000 });
  await expect(comment("Does it work with Astro too?")).not.toHaveClass(/pending/);
  await expect(widget().locator("h2")).toHaveText("6 comments");
  await expect(comment("Does it work with Astro too?").locator(".meta")).toContainText("Lin");
  await expect(comment("Does it work with Astro too?").locator(".you")).toBeVisible();
  await expect(widget().getByLabel("Comment", { exact: true })).toHaveValue("");
  assert.equal(await balance(reader), 0n, "the reader holds no coins");
});

test("a reply, a like, and a deletion", async () => {
  const grace = comment("Does this work with Hugo?");
  await grace.getByRole("button", { name: "Reply" }).first().click();
  await widget().getByLabel("Reply", { exact: true }).fill("Thanks, adding it to my footer now.");
  await approve(widget().locator("form.reply").getByRole("button", { name: "Reply" }));
  const mine = comment("adding it to my footer");
  await expect(mine).not.toHaveClass(/pending/);
  // It sits under Grace's comment.
  await expect(grace.locator("ol li.c").filter({ hasText: "adding it to my footer" })).toHaveCount(1);

  const like = grace.locator(".acts").first().getByRole("button", { name: "Like" });
  await approve(like);
  await expect(grace.locator(".acts").first().getByRole("button", { name: "Unlike" })).toHaveAttribute("aria-pressed", "true");
  // It holds once read back from the chain, after a reload.
  await expect(async () => {
    await page.reload();
    await expect(comment("Does this work with Hugo?").locator(".acts").first().getByRole("button", { name: "Unlike" })).toContainText("1", { timeout: 5000 });
  }).toPass({ timeout: 180_000 });

  const remove = comment("adding it to my footer").getByRole("button", { name: "Delete" });
  await remove.click();
  await expect(remove).toHaveText("Delete?");
  await approve(remove);
  await expect(comment("adding it to my footer")).toHaveCount(0);
  await expect(widget().locator("h2")).toHaveText("6 comments");
});

test("the blog's moderator hides a comment; another reader sees it folded", async () => {
  // The blog names this reader as its moderator.
  await page.goto(demo().replace(/moderators=[^&]+/, `moderators=${reader}`));
  await expect(widget().locator("h2")).toHaveText("6 comments");
  // The old moderator's marks no longer apply here.
  await expect(widget()).toContainText("BUY CHEAP WATCHES");
  await expect(widget().locator(".foot")).toContainText("Moderating");
  const ada = comment("one <script> tag");
  await approve(ada.getByRole("button", { name: "Hide" }));
  await expect(ada).toHaveClass(/marked/);
  await expect(ada.getByRole("button", { name: "Unhide" })).toBeVisible();

  // A reader in another browser, not signed in, sees it folded and can open it.
  const other = await browser.newPage();
  await other.goto(demo().replace(/moderators=[^&]+/, `moderators=${reader}`));
  const view = other.locator("#riposte section.rp");
  await expect(view.locator(".hidden-note")).toHaveCount(1);
  await expect(view).not.toContainText("one <script> tag");
  await view.locator(".hidden-note").getByRole("button", { name: "Show" }).click();
  await expect(view).toContainText("one <script> tag");
  await other.close();
  assert.equal(await balance(reader), 0n, "the moderator holds no coins");
});

/** Sends `amount` coins to `to` from the sponsor's key, which holds the chain's rewards. */
async function fund(to, amount) {
  const sdk = await import("../../vendor/lattice-sdk.js");
  const key = JSON.parse(readFileSync(keep.sponsorKey, "utf8"));
  const chainPath = keep.chain.split("/");
  const state = await (await fetch(`${keep.node}/api/state/account/${key.address}?chainPath=${keep.chain}`, { cache: "no-store" })).json();
  const body = {
    accountActions: [{ owner: key.address, delta: -(amount + 1n) }, { owner: to, delta: amount }],
    actions: [], depositActions: [], receiptActions: [], withdrawalActions: [],
    signers: [key.address], nonce: BigInt(state.nonce ?? 0), chainPath,
  };
  const { publicKey, signature } = sdk.signTransactionBody(body, Uint8Array.from(Buffer.from(key.privateKey, "hex")));
  const response = await fetch(`${keep.node}/transactions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)) });
  assert.ok(response.ok, `funding the reader: ${response.status} ${await response.text()}`);
}

test("a tip: refused without coins, then paid from the balance and highlighted", async () => {
  await page.goto(demo());
  const grace = comment("Does this work with Hugo?");
  await expect(grace).not.toHaveClass(/tipped/);
  const open = () => grace.locator(".acts").first().getByRole("button", { name: "Tip", exact: true });
  const tipper = grace.locator(".tipper");
  await open().click();
  await expect(tipper.locator(".note")).toHaveText(/^You hold 0 coins, and a tip of 1 needs 1\. Tips are paid in coins\.$/);
  await expect(tipper.getByRole("button", { name: "Send 1 coin" })).toBeDisabled();
  await tipper.getByRole("button", { name: "Cancel" }).click();
  await expect(tipper).toHaveCount(0);

  const authorBefore = await balance(keep.mod);
  await fund(reader, 12n);
  await until("the reader's coins land", async () => (await balance(reader)) === 12n, 180);
  await open().click();
  await tipper.getByRole("button", { name: "5", exact: true }).click();
  await expect(tipper.locator(".note")).toContainText("Paid from your balance of 12 coins");
  await approve(tipper.getByRole("button", { name: "Send 5 coins" }));
  await expect(grace).toHaveClass(/tipped/);
  await expect(grace.locator(".tipbadge").first()).toHaveText("★ Tipped 5 coins");
  assert.equal(await balance(reader), 7n, "the tip came from the reader's balance; the sponsor paid the fee");
  assert.equal(await balance(keep.mod), authorBefore + 5n, "the author was paid");
  // Your own comment has no Tip.
  await expect(comment("Does it work with Astro too?").getByRole("button", { name: "Tip", exact: true })).toHaveCount(0);
});

test("the discuss page shows a post's thread from its address, and a reader mutes an author there", async () => {
  const discuss = `${keep.home}discuss/?url=${encodeURIComponent(keep.post)}&node=${encodeURIComponent(keep.node)}&chain=${keep.chain}&sponsor=${encodeURIComponent(keep.sponsor)}&wallet=${encodeURIComponent(walletPage)}`;
  await page.goto(discuss);
  const out = page.locator(".target a.out");
  await expect(out).toHaveText("blog.example.com/posts/hello-world ↗");
  await expect(out).toHaveAttribute("href", keep.post);
  // The same thread the post's embed shows, tips included; no site moderators here.
  await expect(widget().locator("h2")).toHaveText(/^\d+ comments$/);
  await expect(comment("Does this work with Hugo?").locator(".tipbadge").first()).toHaveText("★ Tipped 5 coins");
  await expect(widget()).toContainText("BUY CHEAP WATCHES");
  await expect(widget().getByRole("button", { name: "Hide" })).toHaveCount(0);

  const ada = comment("one <script> tag");
  await approve(ada.getByRole("button", { name: "Mute author" }));
  await expect(widget().locator(".hidden-note").filter({ hasText: "You muted this author." })).toHaveCount(1, { timeout: 180_000 });
  await expect(widget()).not.toContainText("one <script> tag");
  // Only for this reader: the post itself, with its own moderator, still shows Ada.
  await page.goto(demo());
  await expect(comment("one <script> tag")).toBeVisible();
  // Unmuted again, so the tests after see the thread as before.
  await page.goto(discuss);
  await widget().locator(".hidden-note").filter({ hasText: "You muted this author." }).getByRole("button", { name: "Show" }).click();
  await approve(comment("one <script> tag").getByRole("button", { name: "Unmute author" }));
  // Landed once the chain no longer has the mark.
  await expect(comment("one <script> tag").getByRole("button", { name: "Mute author" })).toBeVisible({ timeout: 180_000 });
  await expect(comment("one <script> tag")).not.toHaveClass(/marked/);

  // A pasted address that isn't a web page's is refused, not linked.
  await page.goto(`${keep.home}discuss/?url=${encodeURIComponent("javascript:alert(1)")}`);
  await expect(page.locator("#target")).toContainText("That isn't a web page's address");
  await expect(page.locator(".target a.out")).toHaveCount(0);
});

test("a write the node really loses offers Retry, and Retry lands it", async () => {
  // The node keeps a write sent to its public port only in memory: with no
  // block mined, a restart loses it for real.
  const { dirname } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = dirname(keepFile);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const pooled = async () => (await (await fetch(`${keep.node}/api/mempool?chainPath=${keep.chain}`, { cache: "no-store" })).json().catch(() => ({}))).count ?? 0;
  await page.goto(demo());
  await expect(widget().locator("h2")).toHaveText(/^\d+ comments$/);
  const before = await widget().locator("h2").innerText();
  lattice("mine", "stop");
  try {
    await widget().getByLabel("Comment", { exact: true }).fill("This one the node loses in a restart.");
    await approve(widget().getByRole("button", { name: "Post", exact: true }));
    const mine = comment("the node loses in a restart");
    await expect(mine).toHaveClass(/pending/);
    await until("the node pools it", async () => (await pooled()) > 0, 120);
    lattice("down");
    lattice("up");
    await until("the node is back", async () => (await fetch(`${keep.node}/api/mempool?chainPath=${keep.chain}`).catch(() => null))?.ok, 120);
    assert.equal(await pooled(), 0, "the restart lost it");
  } finally {
    lattice("mine", "start");
  }
  const mine = comment("the node loses in a restart");
  // Not after 20 minutes: as soon as the node neither holds it nor counts it.
  await expect(mine.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 120_000 });
  await expect(mine.locator(".meta")).toHaveAttribute("data-state", "Not saved: it didn't go through");
  await approve(mine.getByRole("button", { name: "Retry" }));
  await expect(mine).not.toHaveClass(/pending/);
  await expect(widget().locator("h2")).toHaveText(`${Number.parseInt(before) + 1} comments`);
  assert.equal(await balance(reader), 7n, "the reader's coins are only what was left after the tip");
});

// Passkeys are driven only in Chromium (its virtual authenticator); reading is checked in every engine.
for (const [name, engine] of [["Firefox", firefox], ["WebKit", webkit]]) {
  test(`a reader in ${name} sees the thread, nested and moderated`, async () => {
    const other = await engine.launch();
    try {
      const reader = await other.newPage();
      const failures = [];
      reader.on("pageerror", (error) => failures.push(error.message));
      await reader.goto(demo());
      const view = reader.locator("#riposte section.rp");
      await expect(view.locator("h2")).toHaveText(/^\d+ comments$/);
      const grace = view.locator("li.c").filter({ hasText: "Does this work with Hugo?" }).first();
      await expect(grace).toContainText("Grace");
      // Ada's answer sits under Grace's question.
      await expect(grace.locator("ol li.c").filter({ hasText: "one <script> tag" })).toHaveCount(1);
      await expect(view.locator(".hidden-note")).toHaveCount(1);
      await expect(view).not.toContainText("BUY CHEAP WATCHES");
      await expect(view.getByRole("button", { name: "Sign in to post" })).toBeVisible();
      assert.deepEqual(failures, [], `no page errors in ${name}`);
    } finally {
      await other.close();
    }
  });
}
