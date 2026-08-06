(function installRalphSafeMarkdown(root) {
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatInline(escaped) {
    return escaped
      .split(/(`[^`\n]*`)/g)
      .map((part) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return `<code>${part.slice(1, -1)}</code>`;
        }
        return part.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      })
      .join("");
  }

  function renderMarkdown(value) {
    const lines = escapeHtml(value).split(/\r?\n/);
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      if (!lines[index].trim()) {
        index += 1;
        continue;
      }

      const fence = lines[index].match(/^```([A-Za-z0-9_+-]*)\s*$/);
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const language = fence[1] || "none";
        blocks.push(`<pre><code class="language-${language}">${code.join("\n")}</code></pre>`);
        continue;
      }

      if (/^\s*[-*]\s+/.test(lines[index])) {
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*[-*]\s+(.+)$/);
          if (!match) break;
          items.push(`<li>${formatInline(match[1])}</li>`);
          index += 1;
        }
        blocks.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      if (/^\s*\d+\.\s+/.test(lines[index])) {
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*\d+\.\s+(.+)$/);
          if (!match) break;
          items.push(`<li>${formatInline(match[1])}</li>`);
          index += 1;
        }
        blocks.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      const paragraph = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^```/.test(lines[index]) &&
        !/^\s*[-*]\s+/.test(lines[index]) &&
        !/^\s*\d+\.\s+/.test(lines[index])
      ) {
        paragraph.push(lines[index]);
        index += 1;
      }
      blocks.push(`<p>${formatInline(paragraph.join("\n")).replaceAll("\n", "<br>")}</p>`);
    }

    return blocks.join("");
  }

  root.RALPH_SAFE_MARKDOWN = Object.freeze({ escapeHtml, renderMarkdown });
})(globalThis);
