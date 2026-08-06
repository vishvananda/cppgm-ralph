import assert from "node:assert/strict";
import test from "node:test";
import "../ralph-viz/safe-markdown.js";

const { renderMarkdown } = globalThis.RALPH_SAFE_MARKDOWN;

test("agent markdown formats common blocks after escaping source HTML", () => {
  const html = renderMarkdown([
    "**Result** <img src=x onerror=alert(1)>",
    "",
    "- first",
    "- `second`",
    "",
    "```cpp",
    "if (a < b) return;",
    "```",
  ].join("\n"));

  assert.match(html, /<strong>Result<\/strong>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<ul><li>first<\/li><li><code>second<\/code><\/li><\/ul>/);
  assert.match(html, /<code class="language-cpp">if \(a &lt; b\) return;<\/code>/);
});
