// How the widget shows comment text and times (widget/text.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, count, renderText } from "../widget/text.mjs";

test("text is escaped: nothing a comment says becomes markup", () => {
  assert.equal(renderText(`<img src=x onerror="alert(1)"> & 'q'`), "&#60;img src=x onerror=&#34;alert(1)&#34;&#62; &#38; &#39;q&#39;");
});

test("http(s) links are linked, nofollow, without trailing punctuation", () => {
  assert.equal(
    renderText("see https://example.com/a?b=1&c=2."),
    'see <a href="https://example.com/a?b=1&#38;c=2" rel="nofollow ugc noopener noreferrer" target="_blank">example.com/a?b=1&#38;c=2</a>.',
  );
  assert.match(renderText("(https://en.wikipedia.org/wiki/Foo_(bar))"), /href="https:\/\/en.wikipedia.org\/wiki\/Foo_\(bar\)"/);
  assert.match(renderText("(see https://x.org/y)"), /href="https:\/\/x.org\/y"/);
  // Only http and https.
  assert.equal(renderText("javascript:alert(1) ftp://x"), "javascript:alert(1) ftp://x");
  // A quote can't break out of the attribute.
  assert.doesNotMatch(renderText('https://x.org/"onmouseover="alert(1)'), /" onmouseover/);
  // Long links are shown cut.
  assert.match(renderText(`https://example.com/${"a".repeat(80)}`), />example\.com\/a+…<\/a>/);
});

test("times read as people say them", () => {
  const now = Date.UTC(2026, 10, 3, 12);
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ago(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(ago(now - 30 * 3600_000, now), "yesterday");
  assert.equal(ago(now - 3 * 86400_000, now), "3 days ago");
  assert.match(ago(Date.UTC(2025, 0, 2), now), /2025/);
  assert.equal(ago(undefined, now), "");
  assert.equal(count(1, "comment"), "1 comment");
  assert.equal(count(0, "comment"), "0 comments");
});
