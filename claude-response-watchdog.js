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
  // Only a negative process wait, optionally guarded by a literal read-only
  // grep, with a sleep-only body and read-only output. Never evaluate the shell.
  const grep = String.raw`(?:grep\s+-q\s+(?:"[\w .|\\:-]+"|'[\w .|\\:-]+')\s+[\w./-]+\s+2>\s*/dev/null\s*&&\s*)?`;
  const wait = String.raw`!\s+pgrep\s+-f\s+(?:'([\w./-]+)'|"([\w./-]+)")\s*>\s*/dev/null;\s*do\s+sleep\s+[1-9]\d*;\s*done`;
  const output = String.raw`(?:;\s*(?:cat\s+[\w./\${}"' -]+|tail\s+(?:-[1-9]\d*|-n\s+[1-9]\d*)\s+[\w./-]+))?`;
  const match = new RegExp(String.raw`^\s*until\s+${grep}${wait}\s*${output}\s*$`).exec(script);
  if (!match) return null;
  try { return new RegExp(match[1] ?? match[2]); } catch { return null; }
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
  async function inspect(version) {
    try {
      if (!current(version)) return;
      onStatus({ status: 'waiting', rootPid });
      const rows = await snapshot();
      if (!current(version)) return;
      const candidates = findSelfWaits(rows, rootPid);
      if (!candidates.length) return;
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
