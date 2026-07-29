#!/usr/bin/env node
// Exercises the engine (gitState.js + tree.js + theme.js) against a battery
// of edge-case repo states: creates, deletes, modifies, long names, huge
// files, binaries, symlinks, special characters, path collisions, etc.
//
// This does NOT drive the interactive Ink UI (no TTY in most environments
// that would run this) — it tests everything that can actually throw or
// produce wrong data: file listing, git status parsing, tree building,
// diff generation, and the color/alignment math.
//
// Each scenario builds its own throwaway git repo under the OS temp dir and
// removes it when done, regardless of pass/fail.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { getChangedFiles, getDiff, getIgnoredDirs, getLastCommit, getUnpushedCount, isGitRepo, listFiles } from "../src/gitState.js";
import { buildTree, flattenVisible, initialExpandedPaths } from "../src/tree.js";
import { COLORS, flashBlend, isBold, statusColor } from "../src/theme.js";
import { tokenizeLine } from "../src/highlight.js";
import { annotateLineNumbers } from "../src/diffLines.js";
import { shouldIgnoreWatchPath } from "../src/gitWatch.js";

// ---------- tiny test harness ----------

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const ms = Date.now() - started;
    passed++;
    console.log(`  ok   ${name}${ms > 200 ? `  (${ms}ms)` : ""}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.stack?.split("\n").slice(0, 3).join("\n       ") ?? err}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------- repo helpers ----------

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-test-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test Runner"]);

  // Tell macOS Spotlight to leave this directory alone. Without it, mdworker
  // can transiently open/lock a file it's just indexed inside a freshly
  // created, fast-changing directory (e.g. the 600-file perf scenario),
  // which shows up later as an ENOTEMPTY/EACCES on cleanup — nothing to do
  // with the tool itself. Excluded via .git/info/exclude, not the repo's
  // own .gitignore, since some scenarios write/read their own .gitignore
  // content — this keeps the marker invisible to every assertion too.
  writeFileSync(join(dir, ".git", "info", "exclude"), "/.metadata_never_index\n", { flag: "a" });
  writeFileSync(join(dir, ".metadata_never_index"), "");

  return dir;
}

function write(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Best-effort: a cleanup hiccup (e.g. a transient OS-level file lock) is not
// a functional failure of the scenario that just ran, and must never be
// reported as one. Retries with backoff, then gives up with just a warning.
function cleanup(dir) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 5) {
        console.warn(`  (warning) couldn't fully remove temp dir ${dir}: ${err.message}`);
        return;
      }
      sleepSync(150 * attempt);
    }
  }
}

// Runs the full engine pipeline the app would run on each refresh, and
// sanity-checks the shapes it returns. Returns everything for further
// scenario-specific assertions.
function exerciseEngine(dir, { respectGitignore = true } = {}) {
  const files = listFiles(dir, respectGitignore);
  const changes = getChangedFiles(dir);
  const tree = buildTree(files, changes);
  const expanded = initialExpandedPaths(changes);
  const rows = flattenVisible(tree, expanded);

  // Every ancestor of every changed file must be in the expand set.
  for (const path of changes.keys()) {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      assert(expanded.has(acc), `expected "${acc}" to be auto-expanded (changed file under it: ${path})`);
    }
  }

  // Row/label alignment math must never go negative, mirroring what
  // App.jsx computes for column alignment.
  for (const row of rows) {
    assert(row.node && typeof row.depth === "number", "row missing node/depth");
    assert(Array.isArray(row.ancestorsLast), "row missing ancestorsLast");
    assert(row.ancestorsLast.length === row.depth, "ancestorsLast length must match depth");
  }

  return { files, changes, tree, rows };
}

function statusOf(changes, path) {
  return changes.get(path)?.status ?? null;
}

// ---------- scenarios ----------

function scenarioEmptyRepoNoCommits() {
  const dir = setupRepo();
  try {
    assert(isGitRepo(dir), "should be recognized as a git repo before any commit");
    const last = getLastCommit(dir);
    assert(last.hash === null, "expected no commit hash in a commit-less repo");

    write(dir, "a.txt", "hello\n");
    const { changes, tree } = exerciseEngine(dir);
    assert(statusOf(changes, "a.txt") === "added", "new file pre-first-commit should read as added");
    assert(tree.children.some((c) => c.name === "a.txt"), "tree should list a.txt");

    // Diff for a file that predates any commit must not try to diff HEAD.
    const diff = getDiff(dir, "a.txt", true);
    assert(diff.includes("hello"), "diff of pre-commit file should show its content as added");
  } finally {
    cleanup(dir);
  }
}

function scenarioBasicAddModifyDelete() {
  const dir = setupRepo();
  try {
    write(dir, "keep.txt", "unchanged\n");
    write(dir, "edit.txt", "line one\nline two\n");
    write(dir, "remove.txt", "bye\n");
    commitAll(dir, "baseline");

    write(dir, "edit.txt", "line one\nline TWO changed\n");
    write(dir, "new.txt", "brand new\n");
    rmSync(join(dir, "remove.txt"));

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "edit.txt") === "modified", "edit.txt should be modified");
    assert(statusOf(changes, "new.txt") === "added", "new.txt should be added");
    assert(statusOf(changes, "remove.txt") === "deleted", "remove.txt should be deleted");
    assert(statusOf(changes, "keep.txt") === null, "keep.txt should be untouched");

    const diff = getDiff(dir, "edit.txt", false);
    assert(diff.includes("+line one\nline TWO changed".split("\n")[1]) || diff.includes("TWO changed"), "diff should show the changed line");
  } finally {
    cleanup(dir);
  }
}

function scenarioUntrackedDirectoryNotCollapsed() {
  // Regression test: git collapses an entirely-new directory into a single
  // "dir/" status line unless --untracked-files=all is used. Verify every
  // file inside shows up individually, not just the directory.
  const dir = setupRepo();
  try {
    write(dir, "README.md", "hi\n");
    commitAll(dir, "baseline");

    write(dir, "fresh/one.js", "1\n");
    write(dir, "fresh/two.js", "2\n");
    write(dir, "fresh/nested/three.js", "3\n");

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "fresh/one.js") === "added", "fresh/one.js should be individually added");
    assert(statusOf(changes, "fresh/two.js") === "added", "fresh/two.js should be individually added");
    assert(statusOf(changes, "fresh/nested/three.js") === "added", "fresh/nested/three.js should be individually added");
    assert(!changes.has("fresh/"), "the collapsed directory entry itself should not leak into the changes map");
  } finally {
    cleanup(dir);
  }
}

function scenarioLongFileAndDirNames() {
  const dir = setupRepo();
  try {
    const longName = "a".repeat(200) + ".js";
    const longDir = "b".repeat(120);
    write(dir, longName, "content\n");
    write(dir, `${longDir}/${longDir}-child.js`, "content\n");

    const { changes, tree, rows } = exerciseEngine(dir);
    assert(statusOf(changes, longName) === "added", "long filename should be tracked as added");
    assert(statusOf(changes, `${longDir}/${longDir}-child.js`) === "added", "file under long dir name should be tracked");
    assert(rows.some((r) => r.node.name === longName), "long filename should appear as a row");
    assert(rows.some((r) => r.node.name === longDir), "long dir name should appear as a row");
    void tree;
  } finally {
    cleanup(dir);
  }
}

function scenarioDeepNesting() {
  const dir = setupRepo();
  try {
    const depth = 30;
    const parts = Array.from({ length: depth }, (_, i) => `d${i}`);
    write(dir, [...parts, "bottom.js"].join("/"), "deep\n");

    const { changes, rows } = exerciseEngine(dir);
    assert(statusOf(changes, [...parts, "bottom.js"].join("/")) === "added", "deeply nested file should be added");
    const bottomRow = rows.find((r) => r.node.name === "bottom.js");
    assert(bottomRow, "bottom.js should be a visible row (path fully auto-expanded)");
    assert(bottomRow.depth === depth, `expected depth ${depth}, got ${bottomRow.depth}`);
    assert(bottomRow.ancestorsLast.length === depth, "ancestorsLast should have one entry per ancestor level");
  } finally {
    cleanup(dir);
  }
}

function scenarioHugeFileManyLines() {
  const dir = setupRepo();
  try {
    const lines = Array.from({ length: 20000 }, (_, i) => `line ${i} — some filler text to bulk it up`);
    write(dir, "huge.txt", lines.join("\n") + "\n");
    commitAll(dir, "baseline huge file");

    // Modify a swath in the middle so the diff itself is non-trivial.
    for (let i = 9000; i < 9500; i++) lines[i] = `CHANGED ${i}`;
    write(dir, "huge.txt", lines.join("\n") + "\n");

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "huge.txt") === "modified", "huge.txt should be modified");

    const diff = getDiff(dir, "huge.txt", false);
    assert(diff.includes("CHANGED 9000"), "diff should include the modified region");
  } finally {
    cleanup(dir);
  }
}

function scenarioHugeSingleLine() {
  const dir = setupRepo();
  try {
    write(dir, "one-huge-line.txt", "x".repeat(200_000) + "\n");
    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "one-huge-line.txt") === "added", "huge single-line file should be added");
    const diff = getDiff(dir, "one-huge-line.txt", true);
    assert(diff.length > 100_000, "diff should include the huge line content");
  } finally {
    cleanup(dir);
  }
}

function scenarioBinaryFile() {
  const dir = setupRepo();
  try {
    const bytes = Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)));
    writeFileSync(join(dir, "blob.bin"), bytes);
    commitAll(dir, "baseline binary");

    const bytes2 = Buffer.from(Array.from({ length: 4096 }, () => Math.floor(Math.random() * 256)));
    writeFileSync(join(dir, "blob.bin"), bytes2);

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "blob.bin") === "modified", "binary file should be modified");
    const diff = getDiff(dir, "blob.bin", false);
    assert(typeof diff === "string", "diff of a binary file should still return a string, not throw");
  } finally {
    cleanup(dir);
  }
}

function scenarioSpecialCharacterNames() {
  const dir = setupRepo();
  try {
    const names = [
      "with space.js",
      "emoji-🔥-file.js",
      "unicode-Ω-café.js",
      "quotes'\"-file.js",
      "dollar$and&amp.js",
      "brackets[1]-(2).js",
    ];
    for (const name of names) write(dir, name, "content\n");

    const { changes, rows } = exerciseEngine(dir);
    for (const name of names) {
      assert(statusOf(changes, name) === "added", `"${name}" should be tracked as added`);
      assert(rows.some((r) => r.node.name === name), `"${name}" should appear as a row`);
    }
  } finally {
    cleanup(dir);
  }
}

function scenarioLeadingDashFilename() {
  const dir = setupRepo();
  try {
    write(dir, "--recursive.js", "content\n");
    write(dir, "-p.js", "content\n");
    commitAll(dir, "baseline");

    write(dir, "--recursive.js", "changed\n");

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "--recursive.js") === "modified", "dash-prefixed filename should not be mistaken for a git flag");
    const diff = getDiff(dir, "--recursive.js", false);
    assert(diff.includes("changed"), "diff for dash-prefixed filename should work");
  } finally {
    cleanup(dir);
  }
}

function scenarioRename() {
  const dir = setupRepo();
  try {
    write(dir, "old-name.js", "export const stable = true;\n".repeat(5));
    commitAll(dir, "baseline");

    git(dir, ["mv", "old-name.js", "new-name.js"]);

    const { changes } = exerciseEngine(dir);
    const entry = changes.get("new-name.js");
    assert(entry, "renamed file should appear at its new path");
    assert(entry.status === "renamed", `expected status "renamed", got "${entry?.status}"`);
    assert(entry.from === "old-name.js", `expected from="old-name.js", got "${entry?.from}"`);
    assert(!changes.has("old-name.js"), "old path should not also appear as a separate entry");
  } finally {
    cleanup(dir);
  }
}

function scenarioEmptyFile() {
  const dir = setupRepo();
  try {
    write(dir, "empty.txt", "");
    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "empty.txt") === "added", "zero-byte file should still be tracked as added");
    const diff = getDiff(dir, "empty.txt", true);
    assert(typeof diff === "string", "diff of an empty file should not throw");
  } finally {
    cleanup(dir);
  }
}

function scenarioSymlinks() {
  const dir = setupRepo();
  try {
    write(dir, "target.js", "export const real = 1;\n");
    symlinkSync("target.js", join(dir, "link.js"));
    symlinkSync("does-not-exist.js", join(dir, "dangling.js"));

    const { changes } = exerciseEngine(dir);
    assert(statusOf(changes, "link.js") === "added", "valid symlink should be tracked");
    assert(statusOf(changes, "dangling.js") === "added", "dangling symlink should still be tracked, not crash");

    // Non-gitignore-respecting raw fs walk should see symlinks too.
    const rawFiles = listFiles(dir, false);
    assert(rawFiles.includes("link.js"), "raw fs walk (--no-gitignore) should include symlinks");
  } finally {
    cleanup(dir);
  }
}

function scenarioGitignoreToggle() {
  const dir = setupRepo();
  try {
    write(dir, ".gitignore", "node_modules/\n*.log\n");
    write(dir, "src/index.js", "real code\n");
    write(dir, "node_modules/pkg/index.js", "vendored\n");
    write(dir, "debug.log", "noise\n");

    const respecting = listFiles(dir, true);
    const raw = listFiles(dir, false);

    assert(!respecting.includes("node_modules/pkg/index.js"), "gitignored file should be excluded by default");
    assert(!respecting.includes("debug.log"), "gitignored *.log should be excluded by default");
    assert(raw.includes("node_modules/pkg/index.js"), "--no-gitignore should include ignored files");
    assert(raw.includes("debug.log"), "--no-gitignore should include ignored files");
    assert(respecting.includes("src/index.js"), "real source file should always be included");
  } finally {
    cleanup(dir);
  }
}

function scenarioFileDirPathCollision() {
  // A path that is a tracked FILE at HEAD, deleted, and replaced on disk by
  // a DIRECTORY of the same name — a real state that only exists in the
  // working-tree-vs-HEAD comparison window this tool lives in.
  const dir = setupRepo();
  try {
    write(dir, "flip", "was a file\n");
    write(dir, "other.txt", "stable\n");
    commitAll(dir, "baseline");

    rmSync(join(dir, "flip"));
    write(dir, "flip/inner.js", "now a directory\n");

    const { changes, tree } = exerciseEngine(dir);
    assert(statusOf(changes, "flip") === "deleted", "old file path should show deleted in the status map");
    assert(statusOf(changes, "flip/inner.js") === "added", "new nested file should show added in the status map");

    const flipNode = tree.children.find((c) => c.name === "flip");
    assert(flipNode, "there should be a single \"flip\" node in the tree, not a crash");
    assert(flipNode.type === "dir", "the directory should win the naming collision since that's the current on-disk reality");
  } finally {
    cleanup(dir);
  }
}

function scenarioManyFilesFlat() {
  const dir = setupRepo();
  try {
    const N = 600;
    for (let i = 0; i < N; i++) write(dir, `file-${String(i).padStart(4, "0")}.txt`, `content ${i}\n`);
    commitAll(dir, "baseline many files");

    for (let i = 0; i < 150; i++) write(dir, `file-${String(i).padStart(4, "0")}.txt`, `CHANGED ${i}\n`);

    const started = Date.now();
    const { changes, tree } = exerciseEngine(dir);
    const ms = Date.now() - started;

    assert(changes.size === 150, `expected 150 changed files, got ${changes.size}`);
    assert(tree.changedCount === 150, `expected root changedCount 150, got ${tree.changedCount}`);
    assert(ms < 5000, `engine pass over ${N} files took too long: ${ms}ms`);
  } finally {
    cleanup(dir);
  }
}

function scenarioRapidChurn() {
  // Simulates an agent hammering the repo: create/modify/delete in a tight
  // loop, re-running the engine after every step, like the debounced
  // refresh() cycle in App.jsx would.
  const dir = setupRepo();
  try {
    write(dir, "seed.txt", "seed\n");
    commitAll(dir, "baseline");

    for (let i = 0; i < 40; i++) {
      const name = `churn-${i % 5}.js`;
      if (i % 7 === 0 && i > 0) {
        rmSync(join(dir, name), { force: true });
      } else {
        write(dir, name, `iteration ${i}\n`);
      }
      exerciseEngine(dir); // must never throw mid-churn
    }
  } finally {
    cleanup(dir);
  }
}

function scenarioCaseOnlyRename() {
  // macOS default (APFS) is case-insensitive but case-preserving — a
  // case-only rename is a known git edge case.
  const dir = setupRepo();
  try {
    write(dir, "casing.js", "content\n");
    commitAll(dir, "baseline");

    git(dir, ["mv", "casing.js", "Casing.js"]);
    exerciseEngine(dir); // must not throw regardless of how git reports it
  } finally {
    cleanup(dir);
  }
}

function scenarioUnpushedNoUpstream() {
  const dir = setupRepo();
  try {
    write(dir, "a.txt", "1\n");
    commitAll(dir, "first");
    assert(getUnpushedCount(dir) === null, "no upstream configured should report null, not 0");
  } finally {
    cleanup(dir);
  }
}

function scenarioUnpushedCount() {
  const dir = setupRepo();
  const remoteDir = mkdtempSync(join(tmpdir(), "pulse-remote-"));
  try {
    git(remoteDir, ["init", "-q", "--bare"]);

    write(dir, "a.txt", "1\n");
    commitAll(dir, "first");
    const branch = git(dir, ["branch", "--show-current"]).trim();
    git(dir, ["remote", "add", "origin", remoteDir]);
    git(dir, ["push", "-q", "-u", "origin", branch]);

    assert(getUnpushedCount(dir) === 0, "freshly pushed repo should report 0 unpushed");

    write(dir, "b.txt", "2\n");
    commitAll(dir, "second");
    write(dir, "c.txt", "3\n");
    commitAll(dir, "third");
    assert(getUnpushedCount(dir) === 2, `expected 2 unpushed commits, got ${getUnpushedCount(dir)}`);

    git(dir, ["push", "-q"]);
    assert(getUnpushedCount(dir) === 0, "after pushing, should be back to 0 unpushed");
  } finally {
    cleanup(dir);
    rmSync(remoteDir, { recursive: true, force: true });
  }
}

function scenarioThemeMath() {
  for (const status of ["modified", "added", "deleted", "renamed", null, undefined]) {
    for (const elapsed of [-1000, 0, 1, 500, 999, 1000, 1001, 5000, 1e9]) {
      const color = flashBlend(status, elapsed);
      assert(/^#[0-9a-f]{6}$/.test(color), `flashBlend(${status}, ${elapsed}) returned invalid hex: ${color}`);
      const bold = isBold(status, elapsed);
      assert(typeof bold === "boolean", `isBold(${status}, ${elapsed}) should return a boolean`);
    }
    const sc = statusColor(status);
    assert(typeof sc === "string" && sc.startsWith("#"), `statusColor(${status}) should return a hex string`);
  }
  assert(Object.values(COLORS).every((c) => typeof c === "string"), "every palette entry should be a string");
}

function scenarioTokenizer() {
  const rejoin = (line) => tokenizeLine(line).map((t) => t.text).join("");

  const cases = [
    ['const x = "hello world";', "string"],
    ["// a comment at the start", "comment"],
    ["  const y = 42; // trailing comment", "comment"],
    ["def foo(self): # python", "comment"],
    ["let s = 'it\\'s escaped';", "string"],
    ["", null],
    ["    ", null],
  ];

  for (const [line, expectSomeType] of cases) {
    const tokens = tokenizeLine(line);
    assert(rejoin(line) === line, `tokenizing "${line}" should losslessly reconstruct the original line`);
    if (expectSomeType) {
      assert(
        tokens.some((t) => t.type === expectSomeType),
        `expected a "${expectSomeType}" token in "${line}", got types: ${tokens.map((t) => t.type).join(",")}`,
      );
    }
  }

  // Keyword recognition, and that it doesn't fire on substrings.
  const kw = tokenizeLine("if (isFinished) return functor;");
  assert(kw.find((t) => t.text === "if")?.type === "keyword", '"if" should be a keyword');
  assert(kw.find((t) => t.text === "return")?.type === "keyword", '"return" should be a keyword');
  assert(kw.find((t) => t.text === "isFinished")?.type === "plain", '"isFinished" should not match "if"');
  assert(kw.find((t) => t.text === "functor")?.type === "plain", '"functor" should not match "for"');

  // A huge line must not hang or blow the stack (tokenizer is a flat loop,
  // not recursive, but worth pinning down given the huge-file scenarios above).
  const huge = "x".repeat(200_000);
  const started = Date.now();
  tokenizeLine(huge);
  assert(Date.now() - started < 2000, "tokenizing a 200k-char line took too long");
}

function scenarioDiffLineNumbers() {
  const dir = setupRepo();
  try {
    const oldLines = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
    write(dir, "seq.txt", oldLines.join("\n") + "\n");
    commitAll(dir, "baseline");

    // A deletion, an insertion, and a modification, all in one small file.
    const newLines = ["alpha", "beta", "delta", "epsilon", "NEWLINE", "zeta", "eta", "THETA", "iota", "kappa"];
    write(dir, "seq.txt", newLines.join("\n") + "\n");

    const diff = getDiff(dir, "seq.txt", false);
    const annotated = annotateLineNumbers(diff.split("\n"));

    // Reconstruct each side of the diff purely from the reported line
    // numbers, and check it against the real content — a git-version-
    // agnostic way to verify the numbering logic itself, not just one
    // hardcoded hunk format. Context lines only carry the *new*-side number
    // (the single-gutter convention this module implements), so only
    // addition/context lines can reconstruct the new file, and only
    // deletion lines can reconstruct the old file.
    const reconstructedNew = [];
    const reconstructedOld = [];
    for (const { line, num } of annotated) {
      if (num == null) continue;
      if (line.startsWith("+") || line.startsWith(" ")) reconstructedNew[num - 1] = line.slice(1);
      if (line.startsWith("-")) reconstructedOld[num - 1] = line.slice(1);
    }

    let newChecked = 0;
    for (let i = 0; i < newLines.length; i++) {
      if (reconstructedNew[i] === undefined) continue;
      newChecked++;
      assert(reconstructedNew[i] === newLines[i], `new-file line ${i + 1}: expected "${newLines[i]}", got "${reconstructedNew[i]}"`);
    }
    let oldChecked = 0;
    for (let i = 0; i < oldLines.length; i++) {
      if (reconstructedOld[i] === undefined) continue;
      oldChecked++;
      assert(reconstructedOld[i] === oldLines[i], `old-file line ${i + 1}: expected "${oldLines[i]}", got "${reconstructedOld[i]}"`);
    }
    assert(newChecked >= 5, "expected most of the new file to be covered by context/addition lines");
    assert(oldChecked === 2, `expected exactly 2 deletion lines (gamma, theta), got ${oldChecked}`);
  } finally {
    cleanup(dir);
  }
}

function scenarioWatchIgnoreRules() {
  const watched = [".git/HEAD", ".git/packed-refs", ".git/refs/heads/main", ".git/refs/heads/feature/x"];
  for (const p of watched) {
    assert(shouldIgnoreWatchPath(p, true) === false, `"${p}" should be watched, not ignored`);
  }

  const ignored = [
    ".git/index",
    ".git/logs/HEAD",
    ".git/objects/ab/cd1234",
    ".git/hooks/pre-commit",
    ".git/refs/tags/v1.0.0",
    ".git/refs/remotes/origin/main",
    ".git/COMMIT_EDITMSG",
  ];
  for (const p of ignored) {
    assert(shouldIgnoreWatchPath(p, true) === true, `"${p}" should be ignored`);
  }

  // The directories on the path to an allowed file must NOT be pruned, or
  // chokidar never descends far enough to see the file itself.
  for (const p of ["", ".git", ".git/refs", ".git/refs/heads"]) {
    assert(shouldIgnoreWatchPath(p, true) === false, `"${p || "(root)"}" must stay traversable`);
  }

  // node_modules is excluded from the *watcher* unconditionally — even with
  // --no-gitignore, which only affects what's displayed, not what's safe to
  // open thousands of file-watch handles inside.
  assert(shouldIgnoreWatchPath("node_modules/foo/index.js", true) === true, "node_modules should be ignored by default");
  assert(shouldIgnoreWatchPath("node_modules/foo/index.js", false) === true, "node_modules should stay ignored even with --no-gitignore");
  assert(shouldIgnoreWatchPath("src/App.jsx", true) === false, "ordinary source files should be watched");

  // Arbitrary gitignored directories (not just node_modules) — the actual
  // EMFILE fix: a venv/, target/, dist/, whatever git reports as ignored.
  const ignoredDirs = ["venv", "target", "some/nested/dir"];
  assert(shouldIgnoreWatchPath("venv", true, ignoredDirs) === true, "an ignored top-level dir itself should be pruned");
  assert(shouldIgnoreWatchPath("venv/lib/python3.11/site-packages/x.py", true, ignoredDirs) === true, "contents of an ignored dir should be pruned");
  assert(shouldIgnoreWatchPath("target/debug/build", true, ignoredDirs) === true, "contents of a nested ignored dir should be pruned");
  assert(shouldIgnoreWatchPath("some/nested/dir/file.txt", true, ignoredDirs) === true, "contents of a multi-segment ignored dir should be pruned");
  assert(shouldIgnoreWatchPath("venv-other/file.txt", true, ignoredDirs) === false, "a dir merely prefixed by an ignored name should NOT be pruned");
  assert(shouldIgnoreWatchPath("venv", false, ignoredDirs) === false, "ignoredDirs should not apply with --no-gitignore");
}

// Regression test for the real bug: `git commit` only touches files inside
// .git (refs, HEAD) — it never touches tracked source files. If the watcher
// ignores all of .git wholesale, nothing ever fires after a commit and the
// app silently goes stale. This drives an actual chokidar watcher, with the
// exact ignore rule the app uses, against a real `git commit`.
async function scenarioCommitTriggersWatcher() {
  const chokidarModule = await import("chokidar");
  const chokidar = chokidarModule.default ?? chokidarModule;
  const dir = setupRepo();
  try {
    write(dir, "a.txt", "hello\n");

    const watcher = chokidar.watch(dir, {
      ignored: (p) => {
        const rel = p.startsWith(dir) ? p.slice(dir.length + 1) : p;
        return shouldIgnoreWatchPath(rel, true);
      },
      ignoreInitial: true,
    });

    const fired = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      watcher.on("all", () => {
        clearTimeout(timer);
        resolve(true);
      });
      // Give the watcher a moment to finish its initial scan before committing.
      setTimeout(() => commitAll(dir, "trigger commit"), 300);
    });

    await watcher.close();
    assert(fired, "a git commit should trigger a watcher event (via .git/HEAD or refs/heads/*)");
  } finally {
    cleanup(dir);
  }
}

function scenarioIgnoredDirsDetection() {
  const dir = setupRepo();
  try {
    write(dir, ".gitignore", "venv/\ndist/\n");
    write(dir, "src/index.js", "content\n");
    write(dir, "venv/lib/site-packages/pkg/__init__.py", "content\n");
    write(dir, "dist/bundle.js", "content\n");
    commitAll(dir, "baseline");

    const ignoredDirs = getIgnoredDirs(dir);
    assert(ignoredDirs.includes("venv"), `expected "venv" in ignored dirs, got: ${ignoredDirs.join(",")}`);
    assert(ignoredDirs.includes("dist"), `expected "dist" in ignored dirs, got: ${ignoredDirs.join(",")}`);
    assert(!ignoredDirs.includes("src"), "src (not ignored) should not show up");
  } finally {
    cleanup(dir);
  }
}

// Direct regression test for the reported EMFILE crash: a gitignored
// directory containing many subdirectories (a venv/, a target/, ...) must
// never have chokidar descend into it, or a real project's dependency/build
// tree opens one file-watch handle per subdirectory until the OS refuses
// with "too many open files".
async function scenarioWatcherPrunesIgnoredDirs() {
  const chokidarModule = await import("chokidar");
  const chokidar = chokidarModule.default ?? chokidarModule;
  const dir = setupRepo();
  try {
    write(dir, ".gitignore", "bigignored/\n");
    write(dir, "src/index.js", "content\n");
    commitAll(dir, "baseline");

    for (let i = 0; i < 150; i++) write(dir, `bigignored/sub-${i}/file.txt`, "x\n");

    const ignoredDirs = getIgnoredDirs(dir);
    assert(ignoredDirs.includes("bigignored"), "bigignored should be detected as a gitignored directory");

    const watcher = chokidar.watch(dir, {
      ignored: (p) => {
        const rel = p.startsWith(dir) ? p.slice(dir.length + 1) : p;
        return shouldIgnoreWatchPath(rel, true, ignoredDirs);
      },
      ignoreInitial: true,
    });

    let errored = false;
    watcher.on("error", () => {
      errored = true;
    });

    await new Promise((resolve) => {
      watcher.on("ready", resolve);
      setTimeout(resolve, 2000); // safety timeout in case 'ready' never fires
    });

    const watched = watcher.getWatched();
    const leakedIntoIgnored = Object.entries(watched).some(
      ([watchedDir, files]) => watchedDir.includes("bigignored/sub-") || files.some((f) => `${watchedDir}/${f}`.includes("bigignored/sub-")),
    );

    await watcher.close();

    assert(!errored, "watcher should not error when a large ignored directory is correctly pruned");
    assert(!leakedIntoIgnored, "watcher should never have descended into the ignored directory's subdirectories");
  } finally {
    cleanup(dir);
  }
}

// ---------- run ----------

const scenarios = [
  ["empty repo, no commits yet", scenarioEmptyRepoNoCommits],
  ["basic add/modify/delete", scenarioBasicAddModifyDelete],
  ["new untracked directory isn't collapsed", scenarioUntrackedDirectoryNotCollapsed],
  ["very long file & directory names", scenarioLongFileAndDirNames],
  ["deep nesting (30 levels)", scenarioDeepNesting],
  ["huge file, many lines (~20k)", scenarioHugeFileManyLines],
  ["huge single line (~200k chars)", scenarioHugeSingleLine],
  ["binary file modify + diff", scenarioBinaryFile],
  ["special characters in filenames", scenarioSpecialCharacterNames],
  ["filenames starting with a dash", scenarioLeadingDashFilename],
  ["rename detection", scenarioRename],
  ["empty (zero-byte) file", scenarioEmptyFile],
  ["symlinks, including dangling", scenarioSymlinks],
  [".gitignore respected vs --no-gitignore", scenarioGitignoreToggle],
  ["file/directory path-type collision", scenarioFileDirPathCollision],
  ["many files in one directory (600, perf)", scenarioManyFilesFlat],
  ["rapid create/modify/delete churn", scenarioRapidChurn],
  ["case-only rename (APFS)", scenarioCaseOnlyRename],
  ["unpushed count: no upstream configured", scenarioUnpushedNoUpstream],
  ["unpushed count: tracks ahead-of-origin", scenarioUnpushedCount],
  ["flash/theme color math edge cases", scenarioThemeMath],
  ["diff syntax tokenizer", scenarioTokenizer],
  ["diff line numbering", scenarioDiffLineNumbers],
  ["watch-ignore rules", scenarioWatchIgnoreRules],
  ["git commit triggers the watcher", scenarioCommitTriggersWatcher],
  ["detects gitignored directories", scenarioIgnoredDirsDetection],
  ["watcher prunes large ignored directories (EMFILE regression)", scenarioWatcherPrunesIgnoredDirs],
];

console.log(`Running ${scenarios.length} scenarios...\n`);
for (const [name, fn] of scenarios) await check(name, fn);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) console.log(`  - ${name}: ${err.message}`);
  process.exit(1);
}
