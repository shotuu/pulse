// Lightweight, language-agnostic tokenizer for diff-line syntax highlighting.
// Not a real per-language grammar — just enough pattern recognition
// (strings, comments, numbers, keywords) to make diff output readable
// across the common C-like/Python/Go/Rust-ish languages people actually
// diff, without pulling in a full highlighter and its language grammars.

const KEYWORDS = new Set([
  // JS/TS
  "function", "const", "let", "var", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "class", "extends", "new", "this", "super",
  "import", "export", "from", "as", "default", "async", "await", "try", "catch",
  "finally", "throw", "typeof", "instanceof", "in", "of", "yield", "static", "get",
  "set", "public", "private", "protected", "interface", "implements", "enum",
  "namespace", "type", "void",
  // Python
  "def", "elif", "except", "pass", "lambda", "with", "raise", "self", "None", "True", "False",
  "and", "or", "not", "is", "None",
  // Go/Rust/C-ish
  "func", "package", "struct", "chan", "defer", "fn", "impl", "mod", "match", "use",
  "pub", "mut", "int", "float", "double", "bool", "char", "string",
  // shared literals
  "true", "false", "null", "undefined", "nil",
]);

export function tokenizeLine(line) {
  const tokens = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    // Rest-of-line comment.
    if ((ch === "/" && line[i + 1] === "/") || ch === "#") {
      tokens.push({ text: line.slice(i), type: "comment" });
      break;
    }

    // String literal (single/double/backtick), handling backslash escapes.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n && line[j] !== quote) {
        if (line[j] === "\\") j++;
        j++;
      }
      j = Math.min(j + 1, n);
      tokens.push({ text: line.slice(i, j), type: "string" });
      i = j;
      continue;
    }

    // Number.
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9a-fA-Fx.]/.test(line[j])) j++;
      tokens.push({ text: line.slice(i, j), type: "number" });
      i = j;
      continue;
    }

    // Identifier / keyword.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      tokens.push({ text: word, type: KEYWORDS.has(word) ? "keyword" : "plain" });
      i = j;
      continue;
    }

    // Everything else (whitespace, punctuation): run until the next
    // recognizable token start.
    let j = i + 1;
    while (j < n && !/[A-Za-z0-9_$"'`#]/.test(line[j]) && !(line[j] === "/" && line[j + 1] === "/")) j++;
    tokens.push({ text: line.slice(i, j), type: "plain" });
    i = j;
  }

  return tokens;
}
