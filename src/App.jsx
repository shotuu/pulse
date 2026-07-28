import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import chokidar from "chokidar";
import { getChangedFiles, getDiff, getLastCommit, listFiles } from "./gitState.js";
import { buildTree, flattenVisible, initialExpandedPaths } from "./tree.js";
import { COLORS, flashBlend, isBold, statusColor } from "./theme.js";

const STATUS_GLYPH = { modified: "M", added: "A", deleted: "D", renamed: "R" };
const DEBOUNCE_MS = 200;

function timeAgo(ms) {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}

export default function App({ cwd, respectGitignore }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  const [tree, setTree] = useState(null);
  const [changes, setChanges] = useState(new Map());
  const [expanded, setExpanded] = useState(() => new Set([""]));
  const [cursor, setCursor] = useState(0);
  const [lastCommit, setLastCommit] = useState({ hash: null, subject: null });
  const [flashes, setFlashes] = useState(new Map()); // path -> timestamp
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState({ mode: "tree" });

  const prevChangedKeys = useRef(new Set());
  const debounceTimer = useRef(null);

  function refresh() {
    const files = listFiles(cwd, respectGitignore);
    const changesMap = getChangedFiles(cwd);
    const nextTree = buildTree(files, changesMap);
    setTree(nextTree);
    setChanges(changesMap);
    setLastCommit(getLastCommit(cwd));

    setExpanded((prevExpanded) => {
      const next = new Set(prevExpanded);
      for (const path of changesMap.keys()) {
        if (!prevChangedKeys.current.has(path)) {
          const parts = path.split("/");
          parts.pop();
          let acc = "";
          for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            next.add(acc);
          }
        }
      }
      return next;
    });
    prevChangedKeys.current = new Set(changesMap.keys());
  }

  useEffect(() => {
    const files = listFiles(cwd, respectGitignore);
    const changesMap = getChangedFiles(cwd);
    const initial = buildTree(files, changesMap);
    setTree(initial);
    setChanges(changesMap);
    setExpanded(initialExpandedPaths(changesMap));
    setLastCommit(getLastCommit(cwd));
    prevChangedKeys.current = new Set(changesMap.keys());

    const watcher = chokidar.watch(cwd, {
      ignored: (path) => {
        if (path.includes("/.git/") || path.endsWith("/.git")) return true;
        if (respectGitignore && path.includes("/node_modules/")) return true;
        return false;
      },
      ignoreInitial: true,
    });

    watcher.on("all", (_event, path) => {
      const rel = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
      setFlashes((prev) => new Map(prev).set(rel, Date.now()));
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(refresh, DEBOUNCE_MS);
    });

    return () => watcher.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, respectGitignore]);

  // Animation tick for the flash fade, plus the header clock.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(id);
  }, []);

  const visibleRows = useMemo(() => (tree ? flattenVisible(tree, expanded) : []), [tree, expanded]);

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, visibleRows.length - 1)));
  }, [visibleRows.length]);

  useInput((input, key) => {
    // no-op when not attached to a real TTY (see isActive below)
    if (view.mode === "diff") {
      if (key.escape || input === "q") setView({ mode: "tree" });
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }

    if (key.downArrow || input === "j") {
      setCursor((c) => Math.min(c + 1, visibleRows.length - 1));
    } else if (key.upArrow || input === "k") {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return || input === "o") {
      const row = visibleRows[cursor];
      if (!row) return;
      if (row.node.type === "dir") {
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(row.node.path)) next.delete(row.node.path);
          else next.add(row.node.path);
          return next;
        });
      } else {
        const change = changes.get(row.node.path);
        const diff = getDiff(cwd, row.node.path, change?.untracked ?? false);
        setView({ mode: "diff", file: row.node, diff });
      }
    } else if (input === "c") {
      const row = visibleRows[cursor];
      if (!row) return;
      if (row.node.type === "dir") {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(row.node.path);
          return next;
        });
      } else {
        const parentPath = row.node.path.split("/").slice(0, -1).join("/");
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(parentPath);
          return next;
        });
        const parentIndex = visibleRows.findIndex((r) => r.node.path === parentPath);
        if (parentIndex >= 0) setCursor(parentIndex);
      }
    }
  }, { isActive: Boolean(process.stdin.isTTY) });

  if (!tree) return <Text dimColor>starting…</Text>;

  if (view.mode === "diff") {
    return <DiffView file={view.file} diff={view.diff} />;
  }

  const clock = new Date(now).toLocaleTimeString([], { hour12: false });
  const counts = { modified: 0, added: 0, deleted: 0 };
  for (const change of changes.values()) {
    if (counts[change.status] !== undefined) counts[change.status] += 1;
  }
  const repoName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const headerRight = lastCommit.hash
    ? `since ${lastCommit.hash} · ${changes.size === 0 ? "clean" : `${changes.size} changed`}`
    : "not a git repo";

  const maxRows = Math.max(4, rows - 6); // header + footer + margins
  let start = 0;
  if (cursor >= maxRows) start = cursor - maxRows + 1;
  const windowRows = visibleRows.slice(start, start + maxRows);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>{repoName}/</Text>
        <Text dimColor>
          {headerRight}    {clock}
        </Text>
      </Box>

      <Box flexDirection="column">
        {windowRows.map((row, i) => (
          <TreeRow
            key={row.node.path}
            row={row}
            selected={start + i === cursor}
            expanded={expanded.has(row.node.path)}
            flashAt={flashes.get(row.node.path)}
            now={now}
          />
        ))}
      </Box>

      <Box justifyContent="space-between">
        <Text dimColor>
          <Text color={COLORS.modified}>{counts.modified} modified</Text> ·{" "}
          <Text color={COLORS.added}>{counts.added} added</Text> ·{" "}
          <Text color={COLORS.deleted}>{counts.deleted} deleted</Text>
        </Text>
        <Text dimColor>[enter] expand/diff  [c] collapse  [q] quit</Text>
      </Box>
    </Box>
  );
}

function TreeRow({ row, selected, expanded, flashAt, now }) {
  const { node, depth } = row;
  const indent = "  ".repeat(depth);
  const elapsed = flashAt ? now - flashAt : null;

  if (node.type === "dir") {
    const hasChanges = node.changedCount > 0;
    const color = hasChanges ? COLORS.dirActive : COLORS.dirClean;
    const arrow = expanded ? "▾" : "▸";
    const badge = hasChanges ? ` ●${node.changedCount}` : "";
    return (
      <Text backgroundColor={selected ? "gray" : undefined}>
        {indent}
        <Text color={color} bold={hasChanges}>
          {arrow} {node.name}/{badge}
        </Text>
      </Text>
    );
  }

  const hasStatus = Boolean(node.status);
  let color = hasStatus ? statusColor(node.status) : undefined;
  let bold = false;
  if (hasStatus && elapsed != null) {
    color = flashBlend(node.status, elapsed);
    bold = isBold(node.status, elapsed);
  } else if (hasStatus) {
    bold = true; // known-changed-since-launch, no flash timestamp on record
  }

  const glyph = hasStatus ? STATUS_GLYPH[node.status] : " ";
  const age = elapsed != null ? timeAgo(elapsed) : "";
  const strike = node.status === "deleted";

  return (
    <Text backgroundColor={selected ? "gray" : undefined}>
      {indent}
      <Text color={color} bold={bold} strikethrough={strike}>
        {node.name}
      </Text>
      {hasStatus ? (
        <Text color={color} bold={bold}>
          {"  "}
          {glyph}
          {age ? `  ${age}` : ""}
        </Text>
      ) : null}
    </Text>
  );
}

function DiffView({ file, diff }) {
  const lines = (diff || "(no diff available)").split("\n");
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={statusColor(file.status)}>
          {file.path} · {file.status}
        </Text>
        <Text dimColor>[esc] back to tree</Text>
      </Box>
      <Box flexDirection="column">
        {lines.map((line, i) => {
          let color;
          if (line.startsWith("+") && !line.startsWith("+++")) color = COLORS.diffAdd;
          else if (line.startsWith("-") && !line.startsWith("---")) color = COLORS.diffDel;
          return (
            <Text key={i} color={color} dimColor={!color}>
              {line || " "}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
