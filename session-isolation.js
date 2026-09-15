import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function normalizePrivateWriteSettings(isolation) {
  const directory = isolation.privateWriteDir;
  const limit = isolation.privateWriteMaxBytes;
  if (directory != null && (typeof directory !== "string" || !path.isAbsolute(directory))) {
    throw new Error("sessionIsolation.privateWriteDir must be an absolute path");
  }
  if (limit != null && (!Number.isSafeInteger(limit) || limit <= 0)) {
    throw new Error("sessionIsolation.privateWriteMaxBytes must be a positive integer (bytes)");
  }
  if (limit != null && !directory) {
    throw new Error("privateWriteMaxBytes requires privateWriteDir");
  }
  if (directory && (process.platform !== "linux" || !isolation.enabled ||
      !isolation.readOnlyRoot || !isolation.privateTmp)) {
    throw new Error("privateWriteDir requires Linux isolation with readOnlyRoot and privateTmp enabled");
  }
  return { ...isolation, privateWriteDir: directory ? path.resolve(directory) : null,
    privateWriteMaxBytes: limit ?? null };
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Resolve existing ancestors as well: a fresh checkout need not exist yet, but
// a symlink in its parent must not bypass the storage boundary.
function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync(absolute);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A dangling symlink is not a path that can safely be created here.
    if (fs.lstatSync(absolute, { throwIfNoEntry: false })) throw error;
    return path.join(canonicalPath(path.dirname(absolute)), path.basename(absolute));
  }
}

export function parseMountPoints(text) {
  return text.trim().split("\n").filter(Boolean).map(line =>
    line.split(" ")[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
}

function validateFilesystem(root, maxBytes) {
  if (maxBytes == null) return;
  const mounts = parseMountPoints(fs.readFileSync("/proc/self/mountinfo", "utf8"));
  if (!mounts.includes(root)) {
    throw new Error(`Private write filesystem is not mounted at ${root}; refusing unbounded fallback`);
  }
  if (mounts.some(mount => mount !== root && contains(root, mount))) {
    throw new Error(`Private write filesystem has nested mounts under ${root}`);
  }
  const stat = fs.statfsSync(root, { bigint: true });
  const capacity = stat.blocks * stat.bsize;
  if (capacity <= 0n || capacity > BigInt(maxBytes)) {
    throw new Error(`Private write filesystem capacity ${capacity} exceeds privateWriteMaxBytes ${maxBytes}`);
  }
}

export function validatePrivateWriteDirectory({ isolation, workdir, stateDir,
  additionalDirectories = [], providerDirectories = [], home = os.homedir() }) {
  normalizePrivateWriteSettings(isolation);
  if (!isolation.privateWriteDir) return null;
  const root = path.resolve(isolation.privateWriteDir);
  // Never create a missing root: it may be an unmounted storage volume.
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory() || fs.realpathSync(root) !== root) {
    throw new Error("privateWriteDir must be an existing, canonical directory (not a symlink)");
  }
  if (rootStat.uid !== process.getuid() || (rootStat.mode & 0o077) !== 0) {
    throw new Error("privateWriteDir must be owned by the runner and have mode 0700");
  }
  if (["/", "/tmp", "/var/tmp", "/dev", "/dev/shm", "/proc", "/sys", home]
    .some(protectedPath => contains(root, path.resolve(protectedPath)))) {
    throw new Error("privateWriteDir must be a dedicated run directory, not a shared/system directory");
  }
  for (const protectedPath of [stateDir, path.join(home, ".cache"), ...providerDirectories].filter(Boolean)) {
    const canonical = canonicalPath(protectedPath);
    if (contains(root, canonical) || contains(canonical, root)) {
      throw new Error(`Private write storage must not overlap Ralph/provider state: ${protectedPath}`);
    }
  }
  if (stateDir && providerDirectories.some(directory =>
    contains(canonicalPath(directory), canonicalPath(stateDir)) ||
    contains(canonicalPath(stateDir), canonicalPath(directory)))) {
    throw new Error("Ralph state must not overlap writable provider state in private-write mode");
  }
  for (const writable of [workdir, ...additionalDirectories].filter(Boolean)) {
    if (!contains(root, canonicalPath(writable)) || canonicalPath(writable) === root) {
      throw new Error(`Writable checkout/additional directory must be inside privateWriteDir: ${writable}`);
    }
  }
  validateFilesystem(root, isolation.privateWriteMaxBytes);
  const layout = { root };
  for (const name of ["tmp", "var-tmp", "shm", "cache", "artifacts"]) {
    const directory = path.join(root, name);
    if (canonicalPath(directory) !== directory) {
      throw new Error(`Private write subdirectory must not be a symlink: ${directory}`);
    }
    layout[name] = directory;
  }
  return layout;
}

export function preparePrivateWriteDirectory(settings) {
  const layout = validatePrivateWriteDirectory(settings);
  if (layout) {
    for (const [name, directory] of Object.entries(layout)) {
      if (name !== "root") fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
  return layout;
}

export function buildSessionIsolationSpawn(command, args, { isolation, cwd = process.cwd(),
  writableDirectories = [], providerDirectories = [], privateWriteSettings = null,
  fdFiles = [], home = os.homedir() }) {
  if (isolation.backend !== "bwrap") {
    throw new Error(`Unsupported session isolation backend: ${isolation.backend}`);
  }
  // Revalidate every spawn, including resumed hosts and verification checks.
  const layout = isolation.privateWriteDir
    ? preparePrivateWriteDirectory({ ...privateWriteSettings, isolation, home,
      additionalDirectories: writableDirectories, providerDirectories }) : null;
  const bwrapArgs = ["--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--unshare-cgroup-try", "--die-with-parent", "--new-session"];
  bwrapArgs.push(isolation.readOnlyRoot ? "--ro-bind" : "--bind", "/", "/");
  if (layout) bwrapArgs.push("--dev", "/dev");
  else bwrapArgs.push("--dev-bind", "/dev", "/dev");
  bwrapArgs.push("--proc", "/proc");
  if (layout) {
    // Mandatory binds, not bind-try: missing storage must never silently turn
    // into an unbounded or ephemeral write path.
    for (const [source, destination] of [[layout.tmp, "/tmp"], [layout["var-tmp"], "/var/tmp"],
      [layout.shm, "/dev/shm"], [layout.cache, path.join(home, ".cache")]]) {
      bwrapArgs.push("--bind", source, destination);
    }
    // Restore the root's host-visible path after /tmp: test/development roots
    // may themselves live below the host's /tmp directory.
    bwrapArgs.push("--bind", layout.root, layout.root);
    for (const [key, value] of Object.entries({ TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp",
      XDG_CACHE_HOME: layout.cache, RALPH_WRITE_DIR: layout.root, RALPH_ARTIFACT_DIR: layout.artifacts })) {
      bwrapArgs.push("--setenv", key, value);
    }
  } else if (isolation.privateTmp) {
    bwrapArgs.push("--tmpfs", "/tmp", "--tmpfs", "/var/tmp");
  }
  const writable = layout ? providerDirectories : writableDirectories;
  for (const directory of new Set(writable.filter(Boolean).map(value => path.resolve(value)))) {
    bwrapArgs.push("--bind-try", directory, directory);
  }
  if (layout && privateWriteSettings?.stateDir) {
    // Preserve read access even when the host state happens to live under /tmp.
    bwrapArgs.push("--ro-bind-try", privateWriteSettings.stateDir, privateWriteSettings.stateDir);
  }
  // File mounts come last, so the private /tmp bind cannot hide an fd prompt.
  for (const { fd, destination } of fdFiles) {
    if (!Number.isInteger(fd) || fd < 3 || !path.isAbsolute(destination)) {
      throw new Error("Isolation fd files require an fd >= 3 and an absolute destination");
    }
    bwrapArgs.push("--ro-bind-data", String(fd), destination);
  }
  bwrapArgs.push("--chdir", cwd, "--", command, ...args);
  return { command: isolation.bwrapPath || "bwrap", args: bwrapArgs };
}
