#!/usr/bin/env bash
#
# Installer for coding-conversation-analyzer.
#
#   curl -fsSL https://raw.githubusercontent.com/theodo-group/coding-conversation-analyzer/main/install.sh | bash
#
# Environment overrides:
#   INSTALL_DIR   where the repo is cloned   (default: ~/.coding-conversation-analyzer)
#   BIN_DIR       where CLI wrappers go       (default: ~/.local/bin)
#   REPO          owner/name on GitHub        (default: theodo-group/coding-conversation-analyzer)
#   BRANCH        branch/tag to install       (default: main)

set -euo pipefail

REPO="${REPO:-theodo-group/coding-conversation-analyzer}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.coding-conversation-analyzer}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$1" >&2; }
err()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js 18+ is required but not found. Install from https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || err "npm is required but not found."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 18 ] || err "Node.js 18+ is required (found $(node -v))."

# --- fetch the repo -----------------------------------------------------------
if command -v git >/dev/null 2>&1; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing install in $INSTALL_DIR"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    info "Cloning $REPO into $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
  fi
else
  info "git not found — downloading tarball"
  command -v curl >/dev/null 2>&1 || err "Need either git or curl to download."
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" \
    | tar -xz -C "$INSTALL_DIR" --strip-components=1
fi

# --- install dependencies -----------------------------------------------------
info "Installing dependencies"
( cd "$INSTALL_DIR" && npm install --no-audit --no-fund --loglevel=error )

# --- create CLI wrappers ------------------------------------------------------
mkdir -p "$BIN_DIR"

make_wrapper() {
  local name="$1" script="$2" target="$BIN_DIR/$1"
  cat > "$target" <<EOF
#!/usr/bin/env bash
exec "$INSTALL_DIR/node_modules/.bin/tsx" "$INSTALL_DIR/src/$script" "\$@"
EOF
  chmod +x "$target"
}

# Remove wrappers from older installs that used the un-prefixed names.
rm -f "$BIN_DIR/export-claude-history" "$BIN_DIR/generate-html"

make_wrapper "cca-export"       "export-claude-history.ts"
make_wrapper "cca-generate-html" "generate-html.ts"

info "Installed commands into $BIN_DIR:"
printf '    cca-export\n    cca-generate-html\n'

# --- PATH hint ----------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on your PATH."
    echo "    Add this to your shell profile (~/.zshrc or ~/.bashrc):"
    echo "        export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

info "Done. Try:  cca-export ./export"
