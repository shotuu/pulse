import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import chokidar from "chokidar";
import { getChangedFiles, getDiff, getLastCommit, getMtime, listFiles } from "./gitState.js";
import { buildTree, flattenVisible, initialExpandedPaths } from "./tree.js";
import { COLORS, flashBlend, isBold, statusColor } from "./theme.js";
import { tokenizeLine } from "./highlight.js";
import { annotateLineNumbers } from "./diffLines.js";
import { shouldIgnoreWatchPath } from "./gitWatch.js";

const TOKEN_COLOR = {
  keyword: COLORS.syntaxKeyword,
  string: COLORS.syntaxString,
  number: COLORS.syntaxNumber,
  comment: COLORS.syntaxComment,
  plain: COLORS.text,
};

const STATUS_GLYPH = { modified: "M", added: "A", deleted: "D", renamed: "R" };
const DEBOUNCE_MS = 200;
// Reserved width for "   M   99s" after the (possibly truncated) name, so a
// long filename never pushes the status glyph/age off the right edge.
const STATUS_SUFFIX_WIDTH = 11; // "   " + glyph(1) + "   " + age(4)

function timeAgo(ms) {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
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
    return GUTTER + prefixLen + 2 /* arrow + space */ + row.node.name.length + 1 /* slash */;
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
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState({ mode: "tree" });

  // path -> timestamp. A plain ref, not state: filesystem events can arrive
  // in tight bursts (an agent writing dozens of files in a loop), and firing
  // a React re-render per event was enough to visibly corrupt the terminal
  // output. The existing 150ms animation tick already re-renders regularly
  // for the flash-fade, so it's what picks up ref updates — no separate
  // render is triggered from the watcher callback itself.
  const flashesRef = useRef(new Map());
  const prevChangedKeys = useRef(new Set());
  const debounceTimer = useRef(null);

  // For changes that predate the watcher (already dirty when the tool
  // launched) there's no live event to time-stamp — fall back to the file's
  // on-disk mtime so the age column isn't just blank. Only seeds paths we
  // haven't already got a (live or seeded) timestamp for.
  function seedFlashesFromMtime(changesMap) {
    for (const [path, change] of changesMap) {
      if (change.status === "deleted" || flashesRef.current.has(path)) continue;
      const mtime = getMtime(cwd, path);
      if (mtime != null) flashesRef.current.set(path, mtime);
    }
  }

  function refresh() {
    const files = listFiles(cwd, respectGitignore);
    const changesMap = getChangedFiles(cwd);
    const nextTree = buildTree(files, changesMap);
    setTree(nextTree);
    setChanges(changesMap);
    setLastCommit(getLastCommit(cwd));
    seedFlashesFromMtime(changesMap);

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
    seedFlashesFromMtime(changesMap);
    prevChangedKeys.current = new Set(changesMap.keys());

    const watcher = chokidar.watch(cwd, {
      ignored: (path) => {
        const rel = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
        return shouldIgnoreWatchPath(rel, respectGitignore);
      },
      ignoreInitial: true,
    });

    watcher.on("all", (_event, path) => {
      const rel = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
      flashesRef.current.set(rel, Date.now()); // no setState here — see flashesRef comment above
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

  // Low-frequency safety net on top of the filesystem watcher: covers any
  // git operation or tooling quirk the watcher doesn't catch (worktrees,
  // packed-refs updates, etc.) so the tree can never drift stale for long.
  useEffect(() => {
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const counts = { modified: 0, added: 0, deleted: 0 };
  for (const change of changes.values()) {
    if (counts[change.status] !== undefined) counts[change.status] += 1;
  }
  const repoName = cwd.split("/").filter(Boolean).pop() ?? cwd;
  const commitAge = lastCommit.timestampMs != null ? `${timeAgo(now - lastCommit.timestampMs)} ago` : null;
  const headerRight = lastCommit.hash
    ? `since ${lastCommit.hash} (${commitAge}) · ${changes.size === 0 ? "clean" : `${changes.size} changed`}`
    : "not a git repo";

  const maxRows = Math.max(4, rows - 8); // header + rules + footer + margins
  let start = 0;
  if (cursor >= maxRows) start = cursor - maxRows + 1;
  const windowRows = visibleRows.slice(start, start + maxRows);
  const rawMaxLabelWidth = visibleRows.reduce((max, row) => Math.max(max, rowLabelWidth(row)), 0);
  // Cap the shared column width to what the terminal can actually fit, so a
  // long name gets truncated (with room reserved for M/A/D + age) instead
  // of pushing the status column past the right edge.
  const maxLabelWidth = Math.min(rawMaxLabelWidth, Math.max(10, columns - STATUS_SUFFIX_WIDTH));
  const rule = "─".repeat(Math.max(10, columns));
  const isClean = changes.size === 0;

  return (
    <Box flexDirection="column">
      <Text color={COLORS.branch}>{rule}</Text>

      <Box justifyContent="space-between">
        <Text bold>{repoName}/</Text>
        <Text color={COLORS.flash}>{headerRight}</Text>
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
              flashAt={flashesRef.current.get(row.node.path)}
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

    // Same truncate-to-fit treatment as file rows, so the ●N badge lands in
    // the same column as file rows' M/A/D instead of trailing the name at a
    // variable offset.
    const dirLabel = `${node.name}/`;
    const nameBudget = Math.max(1, labelWidth - (2 /* gutter */ + prefix.length + 2 /* arrow + space */));
    const displayLabel =
      dirLabel.length > nameBudget
        ? nameBudget <= 1
          ? dirLabel.slice(0, 1)
          : dirLabel.slice(0, nameBudget - 1) + "…"
        : dirLabel;
    const pad = " ".repeat(Math.max(0, nameBudget - displayLabel.length));

    return (
      <Text backgroundColor={selected ? COLORS.selectionBg : undefined} wrap="truncate-end">
        {gutter}
        <Text color={COLORS.branch}>{prefix}</Text>
        <Text color={color} bold={hasChanges}>
          {arrow} {displayLabel}
          {pad}
        </Text>
        {hasChanges ? (
          <Text color={color} bold>
            {"   "}●{node.changedCount}
          </Text>
        ) : null}
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
  const age = elapsed != null ? timeAgo(elapsed).padEnd(4) : "";
  const strike = node.status === "deleted";

  // The name gets whatever's left of the shared column budget after gutter
  // + branch prefix. If it doesn't fit, truncate the name itself (not the
  // whole row) so the status glyph + age always survive at the end.
  const nameBudget = Math.max(1, labelWidth - (2 /* gutter */ + prefix.length));
  let displayName = node.name;
  let pad = "";
  if (node.name.length > nameBudget) {
    displayName = nameBudget <= 1 ? node.name.slice(0, 1) : node.name.slice(0, nameBudget - 1) + "…";
  } else {
    pad = " ".repeat(nameBudget - node.name.length);
  }

  return (
    <Text backgroundColor={selected ? COLORS.selectionBg : undefined} wrap="truncate-end">
      {gutter}
      <Text color={COLORS.branch}>{prefix}</Text>
      <Text color={color} bold={bold} strikethrough={strike}>
        {displayName}
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
  const annotated = useMemo(() => annotateLineNumbers(lines), [lines]);

  const gutterWidth = useMemo(() => {
    let maxNum = 0;
    for (const a of annotated) if (a.num != null && a.num > maxNum) maxNum = a.num;
    return Math.max(2, String(maxNum).length);
  }, [annotated]);

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

  const visibleLines = annotated.slice(scroll, scroll + maxVisible);
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
        {visibleLines.map((entry, i) => (
          <DiffLine key={scroll + i} line={entry.line} num={entry.num} gutterWidth={gutterWidth} columns={columns} />
        ))}
      </Box>
      <Text color={COLORS.branch}>{rule}</Text>
    </Box>
  );
}

// Renders one diff line the way Claude Code/GitHub do: a muted background
// tint carries the added/removed signal, a line-number gutter on the left
// (new-file number for context/additions, old-file number for deletions),
// and the code itself keeps its (lightweight, generic) syntax colors
// instead of being solid green/red.
function DiffLine({ line, num, gutterWidth, columns }) {
  const gutterBlank = " ".repeat(gutterWidth + 1);

  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("\\")) {
    const isHunk = line.startsWith("@@");
    return (
      <Text color={isHunk ? COLORS.diffHunk : undefined} dimColor={!isHunk} wrap="truncate-end">
        {gutterBlank}
        {line || " "}
      </Text>
    );
  }

  const first = line[0];
  let marker = " ";
  let code = line;
  let bg;
  let markerColor;
  if (first === "+") {
    marker = "+";
    code = line.slice(1);
    bg = COLORS.diffAddBg;
    markerColor = COLORS.diffAdd;
  } else if (first === "-") {
    marker = "-";
    code = line.slice(1);
    bg = COLORS.diffDelBg;
    markerColor = COLORS.diffDel;
  } else if (first === " ") {
    code = line.slice(1);
  } else {
    // Doesn't match a unified-diff line shape at all (e.g. "Binary files
    // ... differ") — show as-is rather than guessing.
    return (
      <Text dimColor wrap="truncate-end">
        {gutterBlank}
        {line || " "}
      </Text>
    );
  }

  const tokens = tokenizeLine(code);
  const gutterText = (num != null ? String(num) : "").padStart(gutterWidth);
  const padLen = Math.max(0, columns - (gutterWidth + 1 + 2 + code.length)); // gutter + marker + space + code

  return (
    <Text backgroundColor={bg} wrap="truncate-end">
      <Text color={COLORS.branch}>
        {gutterText}
        {" "}
      </Text>
      {markerColor ? (
        <Text color={markerColor} bold>
          {marker}{" "}
        </Text>
      ) : (
        `${marker} `
      )}
      {tokens.map((t, i) => (
        <Text key={i} color={TOKEN_COLOR[t.type] ?? COLORS.text}>
          {t.text}
        </Text>
      ))}
      {padLen > 0 ? " ".repeat(padLen) : ""}
    </Text>
  );
}
