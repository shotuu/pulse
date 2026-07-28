// Builds a nested tree from a flat file list + a git changes map, and figures
// out which directories should start expanded (every ancestor of a changed file).

function ensureDir(root, parts) {
  let node = root;
  let path = "";
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    const existing = node.children.get(part);
    // A path can be a tracked file at HEAD, get deleted, and be replaced on
    // disk by a directory of the same name — a real state that only exists
    // in the working-tree-vs-HEAD comparison window this tool lives in. The
    // directory wins since that's the current on-disk reality; the stale
    // file entry (if any) is dropped from the tree, though its "deleted"
    // status still counts toward the footer totals via the changes map.
    if (!existing || existing.type !== "dir") {
      node.children.set(part, {
        type: "dir",
        name: part,
        path,
        children: new Map(),
        changedCount: 0,
      });
    }
    node = node.children.get(part);
  }
  return node;
}

export function buildTree(allFilePaths, changesMap) {
  const root = { type: "dir", name: "", path: "", children: new Map(), changedCount: 0 };

  // Union: files present on disk + files git knows changed (covers deletions,
  // which no longer exist on disk but still need a row in the tree).
  const paths = new Set(allFilePaths);
  for (const [path, change] of changesMap) {
    if (change.status === "deleted") paths.add(path);
  }

  for (const path of paths) {
    const parts = path.split("/");
    const fileName = parts.pop();
    const dir = ensureDir(root, parts);
    // Same collision, other direction: don't let a stale file entry clobber
    // a directory that another path already established at this slot.
    if (dir.children.get(fileName)?.type === "dir") continue;
    const change = changesMap.get(path);
    dir.children.set(fileName, {
      type: "file",
      name: fileName,
      path,
      status: change?.status ?? null,
      untracked: change?.untracked ?? false,
    });
  }

  finalize(root);
  return root;
}

function finalize(node) {
  let changedCount = 0;
  const children = [...node.children.values()];

  for (const child of children) {
    if (child.type === "dir") {
      finalize(child);
      changedCount += child.changedCount;
    } else if (child.status) {
      changedCount += 1;
    }
  }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  node.children = children;
  node.changedCount = changedCount;
}

// Every ancestor directory path of every changed file, so the tree opens
// collapsed except along the path down to each edit.
export function initialExpandedPaths(changesMap) {
  const expanded = new Set([""]);
  for (const path of changesMap.keys()) {
    const parts = path.split("/");
    parts.pop();
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      expanded.add(acc);
    }
  }
  return expanded;
}

// Flattens the tree into visible rows given the current expanded-dir set,
// for rendering + cursor navigation. Collapsed dirs still emit one row
// (with their badge) but no descendants.
//
// Each row carries `isLast` (is it the last sibling at its depth) and
// `ancestorsLast` (same, for every ancestor) so the renderer can draw
// proper ├──/└──/│ branch connectors instead of just indentation.
export function flattenVisible(root, expandedPaths, depth = 0, out = [], ancestorsLast = []) {
  root.children.forEach((child, index) => {
    const isLast = index === root.children.length - 1;
    out.push({ node: child, depth, isLast, ancestorsLast });
    if (child.type === "dir" && expandedPaths.has(child.path)) {
      flattenVisible(child, expandedPaths, depth + 1, out, [...ancestorsLast, isLast]);
    }
  });
  return out;
}
