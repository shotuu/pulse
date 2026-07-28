import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function git(cwd, args, allowFail = false) {
  try {
    // stdio pipes stderr instead of inheriting it, so expected/handled
    // failures (e.g. `git log` on a repo with no commits yet) don't print
    // "fatal: ..." straight to the user's terminal.
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    if (allowFail) return err.stdout ?? "";
    throw err;
  }
}

export function isGitRepo(cwd) {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function getLastCommit(cwd) {
  try {
    // \x1f (unit separator) as the delimiter, not a space, since %s can
    // legitimately contain spaces.
    const out = git(cwd, ["log", "-1", "--format=%h\x1f%ct\x1f%s"]).trim();
    const [hash, timestamp, subject] = out.split("\x1f");
    return { hash, timestampMs: Number(timestamp) * 1000, subject };
  } catch {
    return { hash: null, timestampMs: null, subject: null };
  }
}

// Files git considers relevant: tracked + untracked-but-not-ignored.
function listGitFiles(cwd) {
  const out = git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

// Plain filesystem walk, only .git excluded — used when --no-gitignore is passed.
function walkAllFiles(cwd) {
  const results = [];
  const skipDirs = new Set([".git"]);

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Treat symlinks (including dangling ones) as leaf entries, same as
        // `git ls-files` already does in the gitignore-respecting path.
        results.push(relative(cwd, full));
      }
    }
  }

  walk(cwd);
  return results;
}

export function listFiles(cwd, respectGitignore) {
  return respectGitignore ? listGitFiles(cwd) : walkAllFiles(cwd);
}

// Fallback "how long ago" source for changes that predate the watcher —
// e.g. a file already dirty when the tool was launched, so there was never
// a live filesystem event to time-stamp it. Returns null for paths that no
// longer exist on disk (deleted files).
export function getMtime(cwd, filepath) {
  try {
    return statSync(join(cwd, filepath)).mtimeMs;
  } catch {
    return null;
  }
}

const STATUS_MAP = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "added",
  U: "modified",
  "?": "added", // untracked, treated as "added" for coloring purposes
};

// Returns Map<path, { status, from? }> for all changes since HEAD (staged + unstaged).
export function getChangedFiles(cwd) {
  // --untracked-files=all forces git to list every file inside a new
  // directory individually, instead of collapsing it to one "dir/" entry.
  const out = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], true);
  const parts = out.split("\0").filter(Boolean);
  const changes = new Map();

  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    const code = x !== " " && x !== "?" ? x : y;
    const status = STATUS_MAP[code] ?? "modified";

    const untracked = entry.startsWith("??");

    if (code === "R" || code === "C") {
      const from = parts[i + 1];
      changes.set(path, { status, from, untracked });
      i += 2;
    } else {
      changes.set(path, { status, untracked });
      i += 1;
    }
  }

  return changes;
}

export function getDiff(cwd, filepath, untracked) {
  if (untracked) {
    // Never been added to the index — diff against empty rather than HEAD.
    const out = git(cwd, ["diff", "--no-index", "--", "/dev/null", filepath], true);
    return out.split("\n").slice(4).join("\n"); // drop the /dev/null diff header
  }
  return git(cwd, ["diff", "HEAD", "--", filepath], true);
}
