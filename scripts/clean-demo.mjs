#!/usr/bin/env node
// Removes demo-playground/ (everything scripts/demo.mjs creates) from disk
// and, if it was tracked, commits the removal — so `npm run demo` always
// starts from a clean slate again afterward.

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAYGROUND_NAME = "demo-playground";
const PLAYGROUND = join(ROOT, PLAYGROUND_NAME);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasStagedChanges() {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet", "--", PLAYGROUND_NAME], { cwd: ROOT });
    return false;
  } catch {
    return true;
  }
}

if (!existsSync(PLAYGROUND)) {
  console.log("demo-playground/ doesn't exist — nothing to clean up.");
  process.exit(0);
}

rmSync(PLAYGROUND, { recursive: true, force: true });
git(["add", "-A", "--", PLAYGROUND_NAME]);

if (hasStagedChanges()) {
  git(["commit", "-q", "-m", "demo: remove demo-playground"]);
  console.log("Removed demo-playground/ and committed the removal.");
} else {
  console.log("Removed demo-playground/ (nothing was tracked, so no commit needed).");
}
