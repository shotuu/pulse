// Annotates each line of a unified diff with the line number it corresponds
// to in the file — the new-file number for context/added lines, the
// old-file number for removed lines (since that line no longer exists on
// the new side). Numbers reset/advance based on each @@ hunk header.

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function annotateLineNumbers(lines) {
  let oldLine = 0;
  let newLine = 0;

  return lines.map((line) => {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { line, num: null };
    }

    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) {
      return { line, num: null };
    }

    if (line.startsWith("+")) {
      const num = newLine;
      newLine += 1;
      return { line, num };
    }

    if (line.startsWith("-")) {
      const num = oldLine;
      oldLine += 1;
      return { line, num };
    }

    // Context line (or anything else inside a hunk) — advances both sides.
    const num = newLine;
    oldLine += 1;
    newLine += 1;
    return { line, num };
  });
}
