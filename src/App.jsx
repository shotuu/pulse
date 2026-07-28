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
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}

// ├── / └── / │   connectors, built from the ancestor chain's last-child flags.
function branchPrefix(ancestorsLast, isLast) {
  let prefix = "";
  for (const last of ancestorsLast) prefix += last ? "    " : "│   ";
  prefix += isLast ? "└── " : "├── ";
  return prefix;
}

// Raw (uncolored) printed width of everything left of the status column, so
// M/A/D and the age can be padded to a shared column across every row.
function rowLabelWidth(row) {
  const prefixLen = branchPrefix(row.ancestorsLast, row.isLast).length;
  const GUTTER = 2;
  if (row.node.type === "dir") {
    const badge = row.node.changedCount > 0 ? ` ●${row.node.changedCount}` : "";
    return GUTTER + prefixLen + 2 /* arrow + space */ + row.node.name.length + 1 /* slash */ + badge.length;
  }
  return GUTTER + prefixLen + row.node.name.length;
}

export default function App({ cwd, respectGitignore }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 60;

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

  const maxRows = Math.max(4, rows - 8); // header + rules + footer + margins
  let start = 0;
  if (cursor >= maxRows) start = cursor - maxRows + 1;
  const windowRows = visibleRows.slice(start, start + maxRows);
  const maxLabelWidth = visibleRows.reduce((max, row) => Math.max(max, rowLabelWidth(row)), 0);
  const rule = "─".repeat(Math.max(10, columns));
  const isClean = changes.size === 0;

  return (
    <Box flexDirection="column">
      <Text color={COLORS.branch}>{rule}</Text>

      <Box justifyContent="space-between">
        <Text bold>{repoName}/</Text>
        <Text>
          <Text color={COLORS.flash}>{headerRight}</Text>
          <Text dimColor>    {clock}</Text>
        </Text>
      </Box>

      <Box flexDirection="column">
        {visibleRows.length === 0 ? (
          <Text dimColor>(empty directory)</Text>
        ) : (
          windowRows.map((row, i) => (
            <TreeRow
              key={row.node.path}
              row={row}
              selected={start + i === cursor}
              expanded={expanded.has(row.node.path)}
              flashAt={flashes.get(row.node.path)}
              now={now}
              labelWidth={maxLabelWidth}
            />
          ))
        )}
      </Box>

      <Box justifyContent="space-between">
        {isClean ? (
          <Text color={COLORS.added}>✓ clean — nothing changed since last commit</Text>
        ) : (
          <Text dimColor>
            <Text color={COLORS.modified}>{counts.modified} modified</Text> ·{" "}
            <Text color={COLORS.added}>{counts.added} added</Text> ·{" "}
            <Text color={COLORS.deleted}>{counts.deleted} deleted</Text>
          </Text>
        )}
        <Text dimColor>[enter] expand/diff  [c] collapse  [q] quit</Text>
      </Box>

      <Text color={COLORS.branch}>{rule}</Text>
    </Box>
  );
}

function TreeRow({ row, selected, expanded, flashAt, now, labelWidth }) {
  const { node, ancestorsLast, isLast } = row;
  const gutter = selected ? "❯ " : "  ";
  const prefix = branchPrefix(ancestorsLast, isLast);
  const elapsed = flashAt ? now - flashAt : null;

  if (node.type === "dir") {
    const hasChanges = node.changedCount > 0;
    const color = hasChanges ? COLORS.dirActive : selected ? COLORS.dirCleanSelected : COLORS.dirClean;
    const arrow = expanded ? " " : "+";
    const badge = hasChanges ? ` ●${node.changedCount}` : "";
    return (
      <Text backgroundColor={selected ? COLORS.selectionBg : undefined} wrap="truncate-end">
        {gutter}
        <Text color={COLORS.branch}>{prefix}</Text>
        <Text color={color} bold={hasChanges}>
          {arrow} {node.name}/{badge}
        </Text>
      </Text>
    );
  }

  const hasStatus = Boolean(node.status);
  let color = hasStatus ? statusColor(node.status) : selected ? COLORS.dirCleanSelected : undefined;
  let bold = false;
  if (hasStatus && elapsed != null) {
    color = flashBlend(node.status, elapsed);
    bold = isBold(node.status, elapsed);
  } else if (hasStatus) {
    bold = true; // known-changed-since-launch, no flash timestamp on record
  }

  const glyph = hasStatus ? STATUS_GLYPH[node.status] : " ";
  const age = elapsed != null ? timeAgo(elapsed).padEnd(3) : "";
  const strike = node.status === "deleted";

  const ownWidth = 2 /* gutter */ + prefix.length + node.name.length;
  const pad = " ".repeat(Math.max(0, labelWidth - ownWidth));

  return (
    <Text backgroundColor={selected ? COLORS.selectionBg : undefined} wrap="truncate-end">
      {gutter}
      <Text color={COLORS.branch}>{prefix}</Text>
      <Text color={color} bold={bold} strikethrough={strike}>
        {node.name}
      </Text>
      {hasStatus ? (
        <Text color={color} bold={bold}>
          {pad}
          {"   "}
          {glyph}
          {"   "}
          {age}
        </Text>
      ) : null}
    </Text>
  );
}

function DiffView({ file, diff }) {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 60;
  const lines = useMemo(() => (diff || "(no diff available)").split("\n"), [diff]);

  // Same windowing the tree view uses: never hand Ink more lines than the
  // terminal is tall, or the terminal auto-scrolls out from under Ink's own
  // cursor bookkeeping and the next render desyncs (stale lines left behind).
  const maxVisible = Math.max(4, rows - 4); // header + rules + margins
  const maxScroll = Math.max(0, lines.length - maxVisible);
  const [scroll, setScroll] = useState(0);

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") setScroll((s) => Math.min(s + 1, maxScroll));
      else if (key.upArrow || input === "k") setScroll((s) => Math.max(s - 1, 0));
      else if (input === "d" || key.pageDown) setScroll((s) => Math.min(s + maxVisible, maxScroll));
      else if (input === "u" || key.pageUp) setScroll((s) => Math.max(s - maxVisible, 0));
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const visibleLines = lines.slice(scroll, scroll + maxVisible);
  const rule = "─".repeat(Math.max(10, columns));
  const scrollInfo =
    lines.length > maxVisible
      ? `${scroll + 1}-${Math.min(scroll + maxVisible, lines.length)}/${lines.length}`
      : `${lines.length} lines`;

  return (
    <Box flexDirection="column">
      <Text color={COLORS.branch}>{rule}</Text>
      <Box justifyContent="space-between">
        <Text bold color={statusColor(file.status)}>
          {file.path} · {file.status}
        </Text>
        <Text dimColor>
          {scrollInfo}    [j/k] scroll  [esc] back
        </Text>
      </Box>
      <Box flexDirection="column">
        {visibleLines.map((line, i) => {
          let color;
          if (line.startsWith("+") && !line.startsWith("+++")) color = COLORS.diffAdd;
          else if (line.startsWith("-") && !line.startsWith("---")) color = COLORS.diffDel;
          return (
            <Text key={scroll + i} color={color} dimColor={!color} wrap="truncate-end">
              {line || " "}
            </Text>
          );
        })}
      </Box>
      <Text color={COLORS.branch}>{rule}</Text>
    </Box>
  );
}
