#!/usr/bin/env node
import { resolve } from "node:path";
import React from "react";
import { render } from "ink";
import App from "../dist/app.js";
import { isGitRepo } from "./gitState.js";

function parseArgs(argv) {
  const args = { path: process.cwd(), respectGitignore: true, recursive: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--path" || arg === "-path") {
      args.path = argv[++i];
    } else if (arg === "--no-gitignore") {
      args.respectGitignore = false;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`treewatch — live file tree of changes since the last git commit

Usage:
  treewatch [-p|--path <dir>] [--no-gitignore]

Options:
  -p, --path <dir>   Directory to watch (default: current directory)
  --no-gitignore      Do not filter out files matched by .gitignore
  -h, --help          Show this help
`);
  process.exit(0);
}

const cwd = resolve(args.path);

if (!isGitRepo(cwd)) {
  console.error(`treewatch: ${cwd} is not inside a git repository.`);
  process.exit(1);
}

render(React.createElement(App, { cwd, respectGitignore: args.respectGitignore }));
