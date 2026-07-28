// Locked palette (see spec discussion) — muted, dark-theme-first.
export const COLORS = {
  flash: "#89dceb", // sky — "just edited"
  modified: "#f9e2af", // amber
  added: "#a6e3a1", // green
  deleted: "#f38ba8", // rose
  dirActive: "#b4befe", // lavender — directory contains changes
  dirClean: "#6c7086", // muted gray
  dirCleanSelected: "#a6adc8", // brighter gray, used only on the selected row for contrast
  diffAdd: "#a6e3a1", // bright green — only used for the small +/- gutter glyph now
  diffDel: "#f38ba8", // bright rose — only used for the small +/- gutter glyph now
  diffAddBg: "#1f2d20", // muted dark-green row background for additions
  diffDelBg: "#2d1f24", // muted dark-rose row background for deletions
  diffHunk: "#74c7ec", // sapphire — @@ hunk headers
  selectionBg: "#313244", // dark indigo, distinct from dirClean so gray-on-gray never happens
  branch: "#45475a", // tree connector lines (├── └── │)
  text: "#cdd6f4", // default light foreground for plain code tokens
  syntaxKeyword: "#cba6f7", // mauve
  syntaxString: "#fab387", // peach
  syntaxNumber: "#f9e2af", // amber, reused — distinct screen from the tree so no ambiguity
  syntaxComment: "#6c7086", // same muted gray as dirClean
};

export const FLASH_COLOR_MS = 1000; // sky -> status color
export const FLASH_WEIGHT_MS = 4000; // bold -> normal weight

export function statusColor(status) {
  switch (status) {
    case "modified":
      return COLORS.modified;
    case "added":
      return COLORS.added;
    case "deleted":
      return COLORS.deleted;
    case "renamed":
      return COLORS.modified;
    default:
      return COLORS.dirClean;
  }
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Linear RGB blend from the sky flash color to the file's steady status
// color, over FLASH_COLOR_MS. t is clamped to [0, 1].
export function flashBlend(status, elapsedMs) {
  const t = Math.max(0, Math.min(1, elapsedMs / FLASH_COLOR_MS));
  const from = hexToRgb(COLORS.flash);
  const to = hexToRgb(statusColor(status));
  return rgbToHex([lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)]);
}

export function isBold(status, elapsedMs) {
  if (!status) return false;
  return elapsedMs < FLASH_WEIGHT_MS;
}
