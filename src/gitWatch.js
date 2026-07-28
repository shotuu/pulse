// Decides which paths the filesystem watcher should ignore, given a path
// relative to the repo root (e.g. ".git/HEAD", ".git/objects/ab/cd12",
// "src/App.jsx", "node_modules/foo/index.js").
//
// `.git` is mostly noise we don't want to watch (objects, index, logs,
// hooks fire constantly and touch none of what we display) — but a plain
// `git commit`/`merge`/`rebase`/checkout only ever touches files *inside*
// .git (refs, HEAD), never the tracked source files themselves. If we
// ignore all of .git wholesale, the watcher never fires after a commit, so
// neither `git status` nor the "since <hash>" header ever refreshes until
// some unrelated file happens to change. So: let HEAD, packed-refs, and
// refs/heads/* through (and the directories on the path to them, since an
// `ignored` callback that returns true for a directory prunes chokidar's
// traversal and it never looks inside).
export function shouldIgnoreWatchPath(relPath, respectGitignore) {
  if (relPath === "" || relPath === ".git") return false; // must descend into .git to reach refs

  if (relPath.startsWith(".git/")) {
    const inner = relPath.slice(".git/".length);
    if (inner === "HEAD" || inner === "packed-refs") return false;
    if (inner === "refs" || inner === "refs/heads") return false; // descend only
    if (inner.startsWith("refs/heads/")) return false;
    return true; // everything else under .git: objects, index, logs, hooks, refs/tags, ...
  }

  if (respectGitignore && (relPath === "node_modules" || relPath.startsWith("node_modules/"))) {
    return true;
  }

  return false;
}
