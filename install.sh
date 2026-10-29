#!/usr/bin/env sh
# Installs silky by downloading the latest release from GitHub (or the main
# branch if no release exists), installing dependencies, and linking the
# `silky` binary into ~/.local/bin.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/alireza-hariri/silkyprojects/main/install.sh | sh
set -eu

REPO="alireza-hariri/silkyprojects"
PREFIX="${SILKY_PREFIX:-$HOME/.local/share/silky}"
BINDIR="${SILKY_BIN:-$HOME/.local/bin}"

command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node >= 24 is required (https://nodejs.org)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required"; exit 1; }

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "node >= 24 is required (found $(node -v))"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Prefer the latest release tarball; fall back to the main branch archive.
url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | \
  sed -n 's/.*"tarball_url": *"\([^"]*\)".*/\1/p' | head -n 1) || true
if [ -z "${url:-}" ]; then
  echo "No release found; using main branch"
  url="https://codeload.github.com/$REPO/tar.gz/refs/heads/main"
fi

echo "Downloading $url ..."
curl -fsSL "$url" | tar -xz -C "$tmp"
src=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)

mkdir -p "$PREFIX" "$BINDIR"
echo "Installing to $PREFIX ..."
cp -r "$src/." "$PREFIX/"

echo "Installing dependencies ..."
(cd "$PREFIX" && npm install --omit=dev --no-fund --no-audit)

ln -sfn "$PREFIX/bin/silky" "$BINDIR/silky"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "Note: $BINDIR is not on your PATH; add it to your shell profile." ;;
esac

echo "Done. Run: $BINDIR/silky daemon"
