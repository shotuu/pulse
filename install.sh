#!/usr/bin/env bash
# Installs pulse: builds it in place and symlinks the `pulse` command onto
# your PATH. Safe to re-run — it just re-links and re-builds.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/bin"
BIN_NAME="pulse"

echo "Installing pulse from $REPO_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required (v18+). Install it from https://nodejs.org and re-run this script." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: Node.js v18+ is required (found $(node -v))." >&2
  exit 1
fi

echo "-> installing dependencies..."
(cd "$REPO_DIR" && npm install --silent)

echo "-> building..."
(cd "$REPO_DIR" && npm run build --silent)

chmod +x "$REPO_DIR/src/index.js"

mkdir -p "$INSTALL_DIR"
ln -sf "$REPO_DIR/src/index.js" "$INSTALL_DIR/$BIN_NAME"
echo "-> linked $BIN_NAME -> $REPO_DIR/src/index.js"

# Make sure $INSTALL_DIR is actually on PATH, adding it to the shell rc file
# if not (same pattern nvm/rustup/pyenv use).
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    NEEDS_PATH=0
    ;;
  *)
    NEEDS_PATH=1
    ;;
esac

if [ "$NEEDS_PATH" -eq 1 ]; then
  case "${SHELL:-}" in
    */zsh) RC_FILE="$HOME/.zshrc" ;;
    */bash) RC_FILE="$HOME/.bash_profile" ;;
    *) RC_FILE="$HOME/.profile" ;;
  esac

  if ! grep -qs "$INSTALL_DIR" "$RC_FILE" 2>/dev/null; then
    {
      echo ""
      echo "# Added by pulse's install.sh"
      echo "export PATH=\"$INSTALL_DIR:\$PATH\""
    } >> "$RC_FILE"
    echo "-> added $INSTALL_DIR to PATH in $RC_FILE"
    echo ""
    echo "Run 'source $RC_FILE' (or open a new terminal), then: pulse --help"
  else
    echo "-> $INSTALL_DIR is already referenced in $RC_FILE — open a new terminal to pick it up."
  fi
else
  echo "-> $INSTALL_DIR is already on your PATH."
  echo ""
  echo "Done. Try: pulse --help"
fi
