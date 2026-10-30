import fs from 'node:fs/promises';
import path from 'node:path';

// Decode only literal shell words, including the '"'"' quoting used by
// Claude's shell wrapper. Expansions and command substitutions are rejected.
function literalWord(text) {
  let value = '';
  let offset = 0;
  while (text[offset] === "'" || text.slice(offset, offset + 3) === '"\'"') {
    if (text[offset] === "'") {
      const end = text.indexOf("'", offset + 1);
      if (end < 0) return null;
      value += text.slice(offset + 1, end);
      offset = end + 1;
    } else {
      value += "'";
      offset += 3;
    }
  }
  return offset ? { value, rest: text.slice(offset) } : null;
}

// This is a recognizer, never an evaluator. Limit guard/report pipelines to
// read-only commands with literal arguments or simple path-variable expansion.
function readOnlyCommands(text, sequence = false) {
  if (/[\n\r`]/.test(text)) return false;
  const unexpanded = text.replace(/\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})/g, '');
  if (/\$[({\[]/.test(unexpanded)) return false;
  let words = [], word = '', started = false, quote = null, separator = null;
  const flushWord = () => {
    if (started) words.push(word);
    word = ''; started = false;
  };
  const flushCommand = () => {
    flushWord();
    if (!words.length) return false;
    const [command, ...args] = words;
    words = [];
    if (command === 'echo') return args.length > 0 && args.every(arg => /^[\w .:-]+$/.test(arg));
    if (command === 'xargs') return args[0] === 'grep';
    return ['cat', 'tail', 'head', 'grep', 'wc', 'ls'].includes(command);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') {
        if (++i === text.length) return false;
        word += /[$`"\\]/.test(text[i]) ? text[i] : `\\${text[i]}`;
      } else word += c;
    } else if (c === '"' || c === "'") {
      quote = c; started = true; separator = null;
    } else if (/\s/.test(c)) {
      flushWord();
    } else if (c === '2' && !started && /^2>\s*\/dev\/null(?=\s|$)/.test(text.slice(i))) {
      // Only an actual unquoted stderr discard is a permitted redirect.
      i += /^2>\s*\/dev\/null(?=\s|$)/.exec(text.slice(i))[0].length - 1;
    } else if (c === '|' || (sequence && c === ';')) {
      if (!flushCommand()) return false;
      separator = c;
    } else if (/[\w./*${}:=-]/.test(c)) {
      word += c; started = true; separator = null;
    } else return false;
  }
  if (quote) return false;
  return separator === ';' ? true : flushCommand();
}

function readOnlyGuard(text) {
  if (/^\[\s+-s\s+[\w./-]+\s+\]$/.test(text)) return true;
  // Counts produced by a bounded read-only pipeline, as in $(ls ... | wc -l).
  // Nested substitutions, arithmetic, executable helpers and redirects fail
  // readOnlyCommands; the predicate itself is a literal numeric comparison.
  const count = /^\[\s+\$\((.*)\)\s+-(?:eq|ne|ge|gt|le|lt)\s+\d+\s+\]$/.exec(text);
  return readOnlyCommands(count ? count[1] : text);
}

export function pollingPattern(argv) {
  if (!['sh', 'bash', 'dash'].includes(path.basename(argv[0] ?? ''))) return null;
  const index = argv.indexOf('-c');
  if (index < 0) return null;
  let script = argv[index + 1] ?? '';
  if (!script.trimStart().startsWith('until ')) {
    const marker = script.indexOf('&& eval ');
    if (marker < 0) return null;
    const word = literalWord(script.slice(marker + 8));
    if (!word || !/^\s*< \/dev\/null && pwd -P >\| \/tmp\/claude-[\w-]+-cwd\s*$/.test(word.rest)) return null;
    script = word.value;
  }
  const loop = /^\s*until\s+(.+);\s*do\s+sleep\s+[1-9]\d*;\s*done(?:\s*;\s*(.*))?\s*$/.exec(script);
  if (!loop) return null;
  const wait = /^(?:(.+?)\s*&&\s*)?!\s+pgrep\s+-f\s+(?:'([\w./ -]+)'|"([\w./ -]+)")\s*>\s*\/dev\/null(?:\s*&&\s*(.+))?$/.exec(loop[1]);
  if (!wait || (wait[1] && !readOnlyGuard(wait[1].trim())) ||
      (wait[4] && !readOnlyGuard(wait[4].trim())) ||
      (loop[2] && !readOnlyCommands(loop[2].trim(), true))) return null;
  try { return new RegExp(wait[2] ?? wait[3]); } catch { return null; }
}

export async function readProcesses() {
  if (process.platform !== 'linux') return [];
  const names = await fs.readdir('/proc');
  const rows = await Promise.all(names.filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const base = `/proc/${name}`;
      const [stat, command, namespace] = await Promise.all([
        fs.readFile(`${base}/stat`, 'utf8'), fs.readFile(`${base}/cmdline`), fs.readlink(`${base}/ns/pid`),
      ]);
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
      return { pid: Number(name), ppid: Number(fields[1]), start: fields[19], namespace,
        argv: command.toString().split('\0').filter(Boolean) };
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
      throw error; // Incomplete visibility cannot prove that no worker matches.
    }
  }));
  return rows.filter(Boolean);
}

export function findSelfWaits(rows, rootPid) {
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) {
      owned.add(row.pid); changed = true;
    }
  }
  return rows.filter(row => {
    if (!owned.has(row.pid) || row.pid === rootPid) return false;
    const pattern = pollingPattern(row.argv);
    if (!pattern || !pattern.test(row.argv.join(' '))) return false;
    const children = rows.filter(child => child.ppid === row.pid);
    if (children.some(child => !['sleep', 'pgrep'].includes(path.basename(child.argv[0] ?? '')))) return false;
    // pgrep excludes itself, and sees only its own PID namespace. A real
    // matching worker, even outside this subtree, makes cancellation unsafe.
    const matches = rows.filter(other => other.namespace === row.namespace &&
      path.basename(other.argv[0] ?? '') !== 'pgrep' && pattern.test(other.argv.join(' ')));
    return matches.length === 1 && matches[0].pid === row.pid;
  });
}

export function createClaudeResponseWatchdog({ rootPid, graceMs = 60_000,
  snapshot = readProcesses, signal = (pid) => process.kill(pid, 'SIGTERM'), onStatus = () => {} }) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) graceMs = 60_000;
  let timer = null;
  let revision = 0;
  let closed = false;
  const current = version => !closed && revision === version;
  async function inspect(version, warn = true) {
    try {
      if (!current(version)) return;
      if (warn) onStatus({ status: 'waiting', rootPid });
      const rows = await snapshot();
      if (!current(version)) return;
      const candidates = findSelfWaits(rows, rootPid);
      if (!candidates.length) {
        // A report pipeline may be running at the first snapshot, or a real
        // worker may still match. Recheck inactivity without cancelling it.
        timer = setTimeout(() => { void inspect(version, false); }, graceMs);
        timer.unref?.();
        return;
      }
      // Recheck identity and the matching process set before any signal.
      const fresh = await snapshot();
      if (!current(version)) return;
      const confirmed = findSelfWaits(fresh, rootPid);
      for (const row of candidates) {
        if (!confirmed.some(next => next.pid === row.pid && next.start === row.start)) continue;
        if (!current(version)) return;
        for (const target of [...fresh.filter(next => next.ppid === row.pid), row]) {
          try { signal(target.pid); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        onStatus({ status: 'self-wait-stopped', rootPid, pid: row.pid });
      }
    } catch (error) {
      if (current(version)) onStatus({ status: 'inspection-failed', rootPid, message: error.message });
    }
  }
  return {
    observe(event) {
      if (closed || event.type === 'rate_limit_event') return;
      clearTimeout(timer);
      const version = ++revision;
      if (event.type === 'result' && event.subtype === 'success' && !event.is_error) {
        timer = setTimeout(() => { void inspect(version); }, graceMs);
        timer.unref?.();
      }
    },
    close() { closed = true; revision++; clearTimeout(timer); },
  };
}
