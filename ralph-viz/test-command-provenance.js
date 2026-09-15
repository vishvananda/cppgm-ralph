(function installTestCommandProvenance(root) {
  // This is a conservative shell recognizer, not a shell evaluator. In
  // particular, never discover executable commands inside quoted script data.
  function shellSegments(command) {
    const lines = String(command ?? "").replace(/^command \d+: /gm, "").split("\n");
    const kept = [];
    let hereDocs = [];
    for (const line of lines) {
      if (hereDocs.length) {
        if (line.trim() === hereDocs[0]) hereDocs.shift();
        continue;
      }
      kept.push(line);
      hereDocs = [...line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/g)]
        .map(m => m[1] ?? m[2] ?? m[3]);
    }
    const text = kept.join("\n").replace(/\s+\(continued session \d+\)/g, "");
    const segments = [];
    let tokens = [], word = "", quote = null, inWord = false;
    const flush = () => { if (inWord) tokens.push(word); word = ""; inWord = false; };
    const finish = (separator) => { flush(); if (tokens.length) segments.push({ tokens, separator }); tokens = []; };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === "\\" && quote === '"' && /["\\$\n]/.test(text[i + 1] ?? "")) word += text[++i];
        else word += ch;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
      if (ch === "\\" && i + 1 < text.length) { const next = text[++i]; if (next !== "\n") { word += next; inWord = true; } continue; }
      if (ch === "#" && !inWord) { while (i < text.length && text[i] !== "\n") i++; finish(";"); continue; }
      const redirect = text.slice(i).match(/^(?:[012]|&)?(?:>>|>|<)(?:&[012-])?/);
      if (redirect && (!inWord || /[<>]/.test(ch))) {
        flush(); tokens.push(redirect[0]); i += redirect[0].length - 1; continue;
      }
      if (/[;\n|&]/.test(ch)) {
        const op = text[i + 1] === ch && /[|&]/.test(ch) ? ch + text[++i] : ch;
        finish(op); continue;
      }
      if (/\s/.test(ch)) { flush(); continue; }
      word += ch; inWord = true;
    }
    finish("");
    return segments;
  }

  function invocation(tokens) {
    const words = [];
    for (let i = 0; i < tokens.length; i++) {
      if (/^(?:[012]|&)?(?:>>|>|<)$/.test(tokens[i])) { i++; continue; }
      if (/^\d?>&[012-]$/.test(tokens[i])) continue;
      words.push(tokens[i]);
    }
    let at = 0;
    while (/^[A-Za-z_]\w*=/.test(words[at] ?? "")) at++;
    if (words[at] === "env") {
      at++;
      while (at < words.length && (/^\w+=/.test(words[at]) || words[at].startsWith("-"))) {
        if (["-u", "--unset"].includes(words[at])) at++;
        at++;
      }
    }
    if (words[at] === "timeout") {
      at++;
      while (words[at]?.startsWith("-")) at++;
      at++;
    }
    if (words[at]?.split("/").at(-1) !== "make") return null;
    const args = words.slice(at + 1);
    const through = args.find(v => /^test-report-through-pa\d+$/.test(v));
    const singles = args.filter(v => /^test-(?:report-)?pa\d+$/.test(v));
    const selection = words.find(v => /^ACTIVE_TEST_REPORT_PAS=/.test(v));
    let kind, stages, target;
    if (through) { kind = "through"; stages = [through.slice("test-report-through-".length)]; target = through; }
    else if (singles.length) { kind = singles.length === 1 ? "single" : "selected"; stages = singles.map(v => v.match(/pa\d+$/)[0]); target = singles.join(" "); }
    else if (args.includes("test-report") && selection) {
      kind = "selected"; stages = selection.slice(selection.indexOf("=") + 1).match(/\bpa\d+\b/g) ?? [];
      target = `test-report ACTIVE_TEST_REPORT_PAS='${stages.join(" ")}'`;
    } else {
      const c = args.indexOf("-C");
      const directory = c >= 0 ? args[c + 1] : args.find(v => v.startsWith("--directory="))?.slice(12);
      const stage = directory?.replace(/\/+$/, "").split("/").at(-1);
      const local = args.find(v => v === "test" || v === "check");
      if (!/^pa\d+$/.test(stage ?? "") || !local) return null;
      kind = "stage"; stages = [stage]; target = `-C ${stage} ${local}`;
    }
    if (!stages.length) return null;
    const subsetArgs = words.filter(v => /^(?:TEST|GLOB)=/.test(v));
    const hasSubset = subsetArgs.length > 0 || (kind === "stage" && args.includes("check"));
    const keepGoing = words.some(v => /^KEEP_GOING=(?:1|true|yes|on)$/i.test(v));
    const command = `make ${target}${subsetArgs.map(v => " '" + v.replaceAll("'", "") + "'").join("")}${keepGoing ? " KEEP_GOING=1" : ""}`;
    return { kind, stages, stage: stages.at(-1), stageNumber: Number(stages.at(-1).slice(2)),
      target, command, hasSubset, failFast: kind === "stage" && !keepGoing };
  }

  function logPath(value) {
    const text = String(value ?? "").replace(/\$\{([A-Za-z_]\w*)\}/g, "$$$1").replace(/^\.\//, "");
    // Keep environment-rooted paths symbolic: never resolve variables from
    // the viewer's environment or infer ownership from a filename's PA number.
    return text && !/[\s`*?<>|;&()]/.test(text) && !/^\/dev\//.test(text) ? text : null;
  }

  function outputRedirect(tokens) {
    let result = null;
    for (let i = 0; i < tokens.length; i++) {
      if (/^(?:1|&)?>>?$/.test(tokens[i])) result = { path: logPath(tokens[++i]), append: tokens[i - 1].includes(">>") };
    }
    return result;
  }

  function createTracker(entries = []) {
    const logs = new Map(entries);
    function sources(command, scope = "") {
      const result = [];
      const segments = shellSegments(command);
      const key = p => `${scope}\0${p}`;
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index], tokens = segment.tokens;
        const info = invocation(tokens), redirect = outputRedirect(tokens);
        // Unsafe transformations cannot authenticate the original test output.
        const filters = [];
        while (segments[index]?.separator === "|" && segments[index + 1]) filters.push(segments[++index]);
        const safeFilters = filters.every(s => /^(?:grep|egrep|fgrep|rg|sed|tail|head|awk|sort|uniq|wc|cat|cut|tr|tee)$/.test(s.tokens[0]));
        if (redirect?.path) {
          if (info && !redirect.append) logs.set(key(redirect.path), info);
          else logs.set(key(redirect.path), null);
        }
        if (info) {
          if (!redirect && safeFilters) result.push({ info, command: info.command });
          for (const filter of filters) if (filter.tokens[0] === "tee" && safeFilters) {
            for (const value of filter.tokens.slice(1).filter(v => !v.startsWith("-"))) {
              const p = logPath(value); if (p) logs.set(key(p), info);
            }
          }
        } else if (!redirect && safeFilters && /^(?:cat|tail|head|grep|egrep|fgrep|rg|sed|awk)$/.test(tokens[0])) {
          // Diagnostic searches of failure filenames are not summary reads.
          // Do not count them as another report alongside `tail stage.log`.
          if (/^(?:grep|egrep|fgrep|rg)$/.test(tokens[0]) &&
              !tokens.some(v => /SUMMARY|PASSED|PASS|FAIL|====/.test(v))) continue;
          for (const value of tokens.slice(1)) {
            const p = logPath(value);
            if (!p) continue;
            const known = logs.get(key(p));
            if (known) result.push({ info: known, command: known.command, logPath: p });
            else if (!logs.has(key(p)) && /\.(?:log|out|txt)$/.test(p) && !p.startsWith("-")) result.push({ info: null, logPath: p });
          }
        }
        if (["cp", "mv", "rm", "truncate"].includes(tokens[0])) {
          const paths = tokens.slice(1).filter(v => !v.startsWith("-"));
          for (const value of tokens[0] === "cp" || tokens[0] === "mv" ? paths.slice(-1) : paths) {
            const p = logPath(value); if (p) logs.delete(key(p));
          }
        }
      }
      while (logs.size > 512) logs.delete(logs.keys().next().value);
      return result;
    }
    return { sources, entries: () => [...logs] };
  }

  function outputEvidence(sources, output) {
    if (sources.length === 1) return sources[0].info ? [{ ...sources[0], output }] : [];
    if (!sources.length) return [];
    // Multiple log reads often print the stage summary followed by the entire
    // prior-suite total. Pair in command order only when the evidence is complete.
    const summary = /^===== (?:TEST SUMMARY: \d+\s*\/\s*\d+ TESTS PASSED|ALL TESTS PASSED SUCCESSFULLY!(?: \(\d+\s*\/\s*\d+\))?) =====$|^\d+\s*\/\s*\d+ TESTS PASSED$/gm;
    const blocks = [];
    let start = 0, match;
    while ((match = summary.exec(String(output)))) {
      blocks.push(output.slice(start, summary.lastIndex));
      start = summary.lastIndex;
    }
    if (blocks.length !== sources.length) return [];
    return sources.flatMap((source, i) => source.info ? [{ ...source, output: blocks[i] }] : []);
  }

  function directCommand(command) {
    const sources = createTracker().sources(command);
    return sources.length === 1 ? sources[0].info : null;
  }
  root.RALPH_TEST_COMMAND_PROVENANCE = { shellSegments, createTracker, outputEvidence, directCommand };
})(typeof globalThis !== "undefined" ? globalThis : window);
