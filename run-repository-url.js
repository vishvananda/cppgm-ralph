import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Archived runs may no longer have a local checkout. Keep their verified
// destinations here; current runs use their actual origin remote.
const ARCHIVED_REPOSITORIES = new Map([
  "trusted", "opus", "mini", "fable", "luna", "v3opus", "v3codex",
  "v3multi", "v3relay", "v4codex", "v4deep", "v4luna", "v4strands",
  "v4unreal", "v5sol-batched", "v5scratch", "v6sol", "v6opus",
].map(name => [name, `https://github.com/vishvananda/cppgm-run-${name}`]));

export function repositoryRunPrefix(shape) {
  const name = String(shape ?? "").replace(/^\d+-/, "").split("/")[0];
  return name.match(/^(.*?)-(?:gpt-|claude-|opus-|deepseek-)/)?.[1] || name;
}

export function githubRepositoryUrl(remote) {
  const match = String(remote ?? "").trim().match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)\/?$/i,
  );
  return match ? `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` : null;
}

export function archivedRepositoryUrl(shape) {
  return ARCHIVED_REPOSITORIES.get(repositoryRunPrefix(shape)) ?? null;
}

export async function resolveRunRepositoryUrl(shape, worktree) {
  if (worktree) {
    try {
      // Explicit -C avoids accidentally using the viewer's own repository.
      const { stdout } = await execFileAsync("git", ["-C", worktree, "remote", "get-url", "origin"],
        { timeout: 3000, maxBuffer: 16 * 1024 });
      const url = githubRepositoryUrl(stdout);
      if (url) return url;
    } catch { /* Archived checkouts can be absent. */ }
  }
  return archivedRepositoryUrl(shape);
}
