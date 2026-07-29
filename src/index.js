#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import App from "../dist/app.js";
import { isGitRepo } from "./gitState.js";

function parseArgs(argv) {
  const args = { path: null, respectGitignore: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--path" || arg === "-path") {
      args.path = argv[++i];
    } else if (arg === "--no-gitignore") {
      args.respectGitignore = false;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--update") {
      args.update = true;
    } else if (!arg.startsWith("-") && args.path == null) {
      // `pulse <dir>` — a bare positional argument, same as -p/--path.
      args.path = arg;
    }
  }
  if (args.path == null) args.path = process.cwd();
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`pulse — live file tree of changes since the last git commit

Usage:
  pulse [dir] [--no-gitignore]
  pulse [-p|--path <dir>] [--no-gitignore]
  pulse --update

Options:
  [dir]               Directory to watch (default: current directory)
  -p, --path <dir>    Same as [dir], as a flag
  --no-gitignore      Do not filter out files matched by .gitignore
  --update            Pull and rebuild the latest version of pulse itself
  -h, --help          Show this help
`);
  process.exit(0);
}

if (args.update) {
  // import.meta.url resolves through the ~/.local/bin/pulse symlink to this
  // file's real location, so this finds the actual cloned repo regardless
  // of the directory pulse --update is run from.
  const repoDir = fileURLToPath(new URL("..", import.meta.url));
  console.log(`Updating pulse in ${repoDir}...`);
  try {
    execFileSync("git", ["pull", "--ff-only"], { cwd: repoDir, stdio: "inherit" });
    execFileSync("npm", ["install"], { cwd: repoDir, stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd: repoDir, stdio: "inherit" });
  } catch {
    console.error("\npulse: update failed — see the error above.");
    process.exit(1);
  }
  console.log("Updated. Run `pulse --help` to confirm.");
  process.exit(0);
}

const cwd = resolve(args.path);

if (!isGitRepo(cwd)) {
  console.error(`pulse: ${cwd} is not inside a git repository.`);
  process.exit(1);
}

// Take over the terminal like vim/htop/less: switch to the alternate screen
// buffer and hide the cursor, so only the tree is visible while running —
// then restore whatever was on screen before, on any kind of exit.
const isTTY = Boolean(process.stdout.isTTY);
if (isTTY) {
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
}
function restoreScreen() {
  if (isTTY) process.stdout.write("\x1b[?1049l\x1b[?25h");
}
process.on("exit", restoreScreen);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

render(React.createElement(App, { cwd, respectGitignore: args.respectGitignore }));
